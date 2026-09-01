//! Custom local store for the browser: blobs backed by OPFS.
//!
//! Same architecture as `MemStore` (irpc actor on `proto::Command`), but data
//! and outboards live in OPFS files: RAM is no longer the limiting factor,
//! hence the 2 GiB+ target. The code is shared with native tests through the
//! memory backend of [`crate::file`].
//!
//! Implemented subset of commands (the rest replies with an error):
//! `ImportBytes`, `ImportByteStream` (streamed upload), `ImportBao`
//! (download with sparse validated writes), `ExportBao` (network serving),
//! `ExportRanges` (local reads), `Observe`, `BlobStatus`, the minimal tags
//! API, `WaitIdle`, `Shutdown`.
//!
//! Specificity: injectable quota check ([`Options::storage_check`]) called
//! by `ImportBao` before any entry or file is created, to cleanly reject a
//! download that would not fit in the OPFS quota.
//!
//! File naming: uploads land in `upload-<counter>.data/.out` (name known
//! only once the hash is computed), downloads in `<hash>.data/.out`; the
//! actor's entry map carries the actual names for cleanup.

use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    io,
    pin::Pin,
    sync::{Arc, Mutex},
};

use bao_tree::{
    blake3,
    io::{
        fsm,
        mixed::{traverse_ranges_validated, EncodedItem, ReadBytesAt},
        outboard::PreOrderMemOutboard,
        sync::Outboard,
        BaoContentItem,
    },
    BaoTree, ChunkNum, ChunkRanges, TreeNode,
};
use bytes::Bytes;
use iroh_blobs::{
    api::{
        self,
        blobs::{AddProgressItem, BlobStatus},
        proto::{
            self, Bitfield, Command, ExportProgressItem, ExportRangesItem, ImportByteStreamUpdate,
            ListTagsRequest, TagInfo,
        },
        ApiClient, TempTag,
    },
    protocol::ChunkRangesExt,
    store::IROH_BLOCK_SIZE,
    BlobFormat, Hash, HashAndFormat,
};
use n0_future::task::JoinSet;
use range_collections::range_set::RangeSetRange;
use tracing::{error, info, trace};

use crate::file::{read_exact_at, BlobDir, BlobFile};

/// Asynchronous quota check: `Err(msg)` if space is insufficient.
#[cfg(not(target_arch = "wasm32"))]
pub type StorageCheck =
    Arc<dyn Fn(u64) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> + Send + Sync>;
/// Asynchronous quota check: `Err(msg)` if space is insufficient.
#[cfg(target_arch = "wasm32")]
pub type StorageCheck = Arc<dyn Fn(u64) -> Pin<Box<dyn Future<Output = Result<(), String>>>>>;

/// Construction options for the [`LocalStore`].
#[derive(Default)]
pub struct Options {
    /// Storage directory. Defaults to memory (native).
    pub dir: Option<Arc<dyn BlobDir>>,
    /// Quota check, called on `ImportBao` before any entry or file is
    /// created, so a rejection leaves nothing behind.
    pub storage_check: Option<StorageCheck>,
}

/// Custom local store: blobs in files (OPFS on wasm).
#[derive(Clone)]
pub struct LocalStore {
    client: ApiClient,
    entries: EntriesRef,
}

/// Shared map of entries (actor + tasks + wasm access for saving).
type EntriesRef = Arc<Mutex<HashMap<Hash, Entry>>>;

/// A blob's entry: files + observable bitfield.
struct EntryShared {
    /// Names of the files (data, outboard) — used for cleanup.
    names: (String, String),
    data: crate::file::BlobFileImpl,
    outboard: crate::file::BlobFileImpl,
    /// Current bitfield (validated ranges + size), observable.
    watch: tokio::sync::watch::Sender<Bitfield>,
}

impl EntryShared {
    /// Releases the underlying handles (OPFS locks on wasm).
    fn close(&self) {
        self.data.close();
        self.outboard.close();
    }
}

type Entry = Arc<EntryShared>;

impl From<LocalStore> for iroh_blobs::api::Store {
    fn from(value: LocalStore) -> Self {
        iroh_blobs::api::Store::local(value.client)
    }
}

impl LocalStore {
    /// Starts the store actor and returns the client handle.
    pub fn new_with_opts(opts: Options) -> Self {
        let (sender, receiver) = tokio::sync::mpsc::channel(32);
        let entries: EntriesRef = Arc::new(Mutex::new(HashMap::new()));
        let dir = opts.dir.unwrap_or_else(default_dir);
        n0_future::task::spawn(
            Actor {
                commands: receiver,
                tasks: JoinSet::new(),
                entries: entries.clone(),
                tags: BTreeMap::new(),
                dir,
                storage_check: opts.storage_check,
                upload_counter: 0,
                idle_waiters: Vec::new(),
            }
            .run(),
        );
        Self {
            client: sender.into(),
            entries,
        }
    }

    /// The blob's data file, if present (for JS-side saving).
    pub fn data_file(&self, hash: &Hash) -> Option<crate::file::BlobFileImpl> {
        self.entries
            .lock()
            .unwrap()
            .get(hash)
            .map(|e| e.data.clone())
    }
}

fn default_dir() -> Arc<dyn BlobDir> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        Arc::new(crate::file::MemDir::new())
    }
    #[cfg(target_arch = "wasm32")]
    {
        // wasm.rs always builds a LocalStore with an OpfsDir; this fallback
        // only exists so the code compiles.
        Arc::new(NullDir)
    }
}

#[cfg(target_arch = "wasm32")]
struct NullDir;

#[cfg(target_arch = "wasm32")]
impl BlobDir for NullDir {
    fn create(
        &self,
        _name: &str,
    ) -> crate::file::DirFut<'_, io::Result<crate::file::BlobFileImpl>> {
        Box::pin(async {
            Err(io::Error::other(
                "no storage directory configured (wasm.rs must pass an OpfsDir)",
            ))
        })
    }

    fn remove(&self, _name: &str) -> crate::file::DirFut<'_, io::Result<()>> {
        Box::pin(async { Ok(()) })
    }
}

/// Result of an import task, processed by the actor (entry insertion).
enum TaskResult {
    Unit(()),
    Import(Result<ImportEntry, api::Error>),
}

impl From<()> for TaskResult {
    fn from((): ()) -> Self {
        Self::Unit(())
    }
}

impl From<Result<ImportEntry, api::Error>> for TaskResult {
    fn from(value: Result<ImportEntry, api::Error>) -> Self {
        Self::Import(value)
    }
}

/// Result of a successful import, to insert into the actor's state.
struct ImportEntry {
    hash: Hash,
    size: u64,
    names: (String, String),
    data: crate::file::BlobFileImpl,
    outboard: crate::file::BlobFileImpl,
    format: BlobFormat,
    tx: irpc::channel::mpsc::Sender<AddProgressItem>,
}

struct Actor {
    commands: tokio::sync::mpsc::Receiver<Command>,
    tasks: JoinSet<TaskResult>,
    entries: EntriesRef,
    tags: BTreeMap<api::Tag, HashAndFormat>,
    dir: Arc<dyn BlobDir>,
    storage_check: Option<StorageCheck>,
    upload_counter: u64,
    idle_waiters: Vec<irpc::channel::oneshot::Sender<()>>,
}

impl Actor {
    #[cfg(not(target_arch = "wasm32"))]
    fn spawn<F, T>(&mut self, f: F)
    where
        F: Future<Output = T> + Send + 'static,
        T: Into<TaskResult>,
    {
        self.tasks.spawn(async move { f.await.into() });
    }

    #[cfg(target_arch = "wasm32")]
    fn spawn<F, T>(&mut self, f: F)
    where
        F: Future<Output = T> + 'static,
        T: Into<TaskResult>,
    {
        self.tasks.spawn(async move { f.await.into() });
    }

    fn get_entry(&self, hash: &Hash) -> Option<Entry> {
        self.entries.lock().unwrap().get(hash).cloned()
    }

    /// Fetches the entry for the hash, or creates an empty one (files +
    /// empty bitfield).
    async fn get_or_create_entry(&mut self, hash: Hash) -> io::Result<Entry> {
        if let Some(entry) = self.get_entry(&hash) {
            return Ok(entry);
        }
        self.create_entry(hash).await
    }

    async fn create_entry(&mut self, hash: Hash) -> io::Result<Entry> {
        let names = (format!("{hash}.data"), format!("{hash}.out"));
        let data = self.dir.create(&names.0).await?;
        let outboard = self.dir.create(&names.1).await?;
        let (watch, _) = tokio::sync::watch::channel(Bitfield::empty());
        let entry = Arc::new(EntryShared {
            names,
            data,
            outboard,
            watch,
        });
        self.entries.lock().unwrap().insert(hash, entry.clone());
        Ok(entry)
    }

    /// Removes a partial entry (files included), e.g. after a quota failure.
    async fn remove_entry(&mut self, hash: &Hash) {
        let entry = self.entries.lock().unwrap().remove(hash);
        if let Some(entry) = entry {
            entry.close();
            let _ = self.dir.remove(&entry.names.0).await;
            let _ = self.dir.remove(&entry.names.1).await;
        }
    }

    async fn run(mut self) {
        // Entry for the empty blob (Hash::EMPTY), always available.
        if let Err(err) = self.create_entry(Hash::EMPTY).await {
            error!("failed to create empty blob entry: {err}");
            return;
        }
        let shutdown = loop {
            tokio::select! {
                cmd = self.commands.recv() => {
                    let Some(cmd) = cmd else {
                        // last client disconnected: immediate shutdown
                        break None;
                    };
                    if let Some(shutdown) = self.handle_command(cmd).await {
                        break Some(shutdown);
                    }
                }
                Some(res) = self.tasks.join_next(), if !self.tasks.is_empty() => {
                    match res {
                        Ok(TaskResult::Import(res)) => self.finish_import(res).await,
                        Ok(TaskResult::Unit(())) => {}
                        Err(e) if e.is_cancelled() => trace!("task cancelled: {e}"),
                        Err(e) => error!("task failed: {e}"),
                    }
                    if self.tasks.is_empty() {
                        for tx in self.idle_waiters.drain(..) {
                            tx.send(()).await.ok();
                        }
                    }
                }
            }
        };
        if let Some(shutdown) = shutdown {
            shutdown.tx.send(()).await.ok();
        }
        // Release all remaining handles (OPFS locks on wasm).
        for (_, entry) in self.entries.lock().unwrap().drain() {
            entry.close();
        }
    }

    async fn finish_import(&mut self, res: Result<ImportEntry, api::Error>) {
        let entry = match res {
            Ok(entry) => entry,
            Err(e) => {
                error!("import failed: {e}");
                return;
            }
        };
        {
            let mut entries = self.entries.lock().unwrap();
            match entries.entry(entry.hash) {
                std::collections::hash_map::Entry::Vacant(vac) => {
                    let (watch, _) = tokio::sync::watch::channel(Bitfield::complete(entry.size));
                    vac.insert(Arc::new(EntryShared {
                        names: entry.names.clone(),
                        data: entry.data,
                        outboard: entry.outboard,
                        watch,
                    }));
                }
                std::collections::hash_map::Entry::Occupied(_) => {
                    // already present: close and delete the temporary files
                    entry.data.close();
                    entry.outboard.close();
                    let dir = self.dir.clone();
                    let names = entry.names.clone();
                    n0_future::task::spawn(async move {
                        let _ = dir.remove(&names.0).await;
                        let _ = dir.remove(&names.1).await;
                    });
                }
            }
        }
        info!(hash = %entry.hash, size = entry.size, "import complete");
        let tt = TempTag::new(
            HashAndFormat {
                hash: entry.hash,
                format: entry.format,
            },
            None,
        );
        entry.tx.send(AddProgressItem::Done(tt)).await.ok();
    }

    async fn handle_command(&mut self, cmd: Command) -> Option<proto::ShutdownMsg> {
        match cmd {
            Command::ImportBytes(msg) => {
                let proto::ImportBytesMsg { inner, tx, .. } = msg;
                let name = self.next_upload_name();
                self.spawn(import_bytes_task(
                    inner.data,
                    inner.format,
                    tx,
                    self.dir.clone(),
                    name,
                ));
            }
            Command::ImportByteStream(msg) => {
                let proto::ImportByteStreamMsg { inner, rx, tx, .. } = msg;
                let name = self.next_upload_name();
                self.spawn(import_byte_stream(
                    inner.format,
                    rx,
                    tx,
                    self.dir.clone(),
                    name,
                ));
            }
            Command::ImportBao(msg) => {
                let proto::ImportBaoMsg { inner, rx, tx, .. } = msg;
                // Quota check before creating anything: the size is known
                // from the request (bao header), so a rejection leaves no
                // entry and no file behind.
                if let Some(check) = &self.storage_check {
                    if let Err(msg) = check(inner.size.get()).await {
                        tx.send(Err(api::Error::other(msg))).await.ok();
                        return None;
                    }
                }
                let entry = match self.get_or_create_entry(inner.hash).await {
                    Ok(entry) => entry,
                    Err(err) => {
                        tx.send(Err(api::Error::Io(err))).await.ok();
                        return None;
                    }
                };
                // already complete: reply without rewriting
                if entry.watch.borrow().is_complete() {
                    tx.send(Ok(())).await.ok();
                    return None;
                }
                self.spawn(async move {
                    import_bao(entry, inner.size, rx, tx).await;
                });
            }
            Command::Observe(msg) => {
                let proto::ObserveMsg {
                    inner: proto::ObserveRequest { hash },
                    tx,
                    ..
                } = msg;
                match self.get_or_create_entry(hash).await {
                    Ok(entry) => self.spawn(async move {
                        if let Err(e) = observe(entry, tx).await {
                            error!("observe failed: {e}");
                        }
                    }),
                    Err(_) => return None,
                }
            }
            Command::ExportBao(msg) => {
                let proto::ExportBaoMsg {
                    inner: proto::ExportBaoRequest { hash, ranges },
                    tx,
                    ..
                } = msg;
                let entry = self.get_entry(&hash);
                self.spawn(async move {
                    if let Err(e) = export_bao(entry, hash, ranges, tx).await {
                        error!("export_bao failed: {e}");
                    }
                });
            }
            Command::ExportRanges(msg) => {
                let proto::ExportRangesMsg { inner, tx, .. } = msg;
                let entry = self.get_entry(&inner.hash);
                self.spawn(async move {
                    if let Err(e) = export_ranges(inner, entry, tx).await {
                        error!("export_ranges failed: {e}");
                    }
                });
            }
            Command::BlobStatus(msg) => {
                let proto::BlobStatusMsg {
                    inner: proto::BlobStatusRequest { hash },
                    tx,
                    ..
                } = msg;
                let status = match self.get_entry(&hash) {
                    None => BlobStatus::NotFound,
                    Some(entry) => {
                        let bitfield = entry.watch.borrow().clone();
                        if bitfield.is_complete() {
                            BlobStatus::Complete {
                                size: bitfield.size(),
                            }
                        } else {
                            // UI-useful progress: validated bytes received
                            BlobStatus::Partial {
                                size: Some(bitfield.total_bytes()),
                            }
                        }
                    }
                };
                tx.send(status).await.ok();
            }
            Command::ListBlobs(cmd) => {
                let hashes: Vec<Hash> = self.entries.lock().unwrap().keys().copied().collect();
                self.spawn(async move {
                    for hash in hashes {
                        if cmd.tx.send(Ok(hash)).await.is_err() {
                            break;
                        }
                    }
                });
            }
            Command::DeleteBlobs(msg) => {
                let proto::DeleteBlobsMsg {
                    inner: proto::BlobDeleteRequest { hashes, .. },
                    tx,
                    ..
                } = msg;
                for hash in hashes {
                    if hash != Hash::EMPTY {
                        self.remove_entry(&hash).await;
                    }
                }
                tx.send(Ok(())).await.ok();
            }
            Command::CreateTag(msg) => {
                let proto::CreateTagMsg { inner, tx, .. } = msg;
                let tag = api::Tag::auto(n0_future::time::SystemTime::now(), |tag| {
                    self.tags.contains_key(&api::Tag::from(tag))
                });
                self.tags.insert(tag.clone(), inner.value);
                tx.send(Ok(tag)).await.ok();
            }
            Command::SetTag(msg) => {
                let proto::SetTagMsg {
                    inner: proto::SetTagRequest { name, value },
                    tx,
                    ..
                } = msg;
                self.tags.insert(name, value);
                tx.send(Ok(())).await.ok();
            }
            Command::ListTags(msg) => {
                let proto::ListTagsMsg {
                    inner:
                        ListTagsRequest {
                            from,
                            to,
                            raw,
                            hash_seq,
                        },
                    tx,
                    ..
                } = msg;
                let tags = self
                    .tags
                    .iter()
                    .filter(|&(tag, value)| {
                        if let Some(from) = &from {
                            if tag < from {
                                return false;
                            }
                        }
                        if let Some(to) = &to {
                            if tag >= to {
                                return false;
                            }
                        }
                        (raw && value.format.is_raw()) || (hash_seq && value.format.is_hash_seq())
                    })
                    .map(|(tag, value)| TagInfo {
                        name: tag.clone(),
                        hash: value.hash,
                        format: value.format,
                    })
                    .map(Ok);
                tx.send(tags.collect()).await.ok();
            }
            Command::DeleteTags(msg) => {
                let proto::DeleteTagsMsg {
                    inner: proto::DeleteTagsRequest { from, to },
                    tx,
                    ..
                } = msg;
                let mut deleted = 0;
                self.tags.retain(|tag, _| {
                    if let Some(from) = &from {
                        if tag < from {
                            return true;
                        }
                    }
                    if let Some(to) = &to {
                        if tag >= to {
                            return true;
                        }
                    }
                    deleted += 1;
                    false
                });
                tx.send(Ok(deleted)).await.ok();
            }
            Command::RenameTag(msg) => {
                let proto::RenameTagMsg {
                    inner: proto::RenameTagRequest { from, to },
                    tx,
                    ..
                } = msg;
                let Some(value) = self.tags.remove(&from) else {
                    tx.send(Err(api::Error::other("tag not found"))).await.ok();
                    return None;
                };
                self.tags.insert(to, value);
                tx.send(Ok(())).await.ok();
            }
            Command::CreateTempTag(msg) => {
                let proto::CreateTempTagMsg { tx, inner, .. } = msg;
                // No GC: temp tags are pure markers, without reference
                // counting (see startup purge).
                tx.send(TempTag::new(inner.value, None)).await.ok();
            }
            Command::ListTempTags(msg) => {
                msg.tx.send(Vec::new()).await.ok();
            }
            Command::Batch(msg) => {
                // Unsupported: our flows go through Scope::GLOBAL. Reply with
                // a global scope (inert without GC) and ignore the Drops.
                let proto::BatchMsg { tx, mut rx, .. } = msg;
                tx.send(proto::Scope::GLOBAL).await.ok();
                n0_future::task::spawn(async move { while let Ok(Some(_)) = rx.recv().await {} });
            }
            Command::ClearProtected(msg) => {
                msg.tx.send(Ok(())).await.ok();
            }
            Command::SyncDb(msg) => {
                msg.tx.send(Ok(())).await.ok();
            }
            Command::WaitIdle(msg) => {
                if self.tasks.is_empty() {
                    msg.tx.send(()).await.ok();
                } else {
                    self.idle_waiters.push(msg.tx);
                }
            }
            Command::Shutdown(msg) => return Some(msg),
            Command::ImportPath(msg) => {
                msg.tx
                    .send(AddProgressItem::Error(io::Error::other(
                        "import_path is not supported",
                    )))
                    .await
                    .ok();
            }
            Command::ExportPath(msg) => {
                msg.tx
                    .send(ExportProgressItem::Error(api::Error::other(
                        "export_path is not supported",
                    )))
                    .await
                    .ok();
            }
        }
        None
    }

    fn next_upload_name(&mut self) -> String {
        self.upload_counter += 1;
        format!("upload-{}", self.upload_counter)
    }
}

// ==== import/export tasks ====================================================

async fn import_bytes_task(
    data: Bytes,
    format: BlobFormat,
    tx: irpc::channel::mpsc::Sender<AddProgressItem>,
    dir: Arc<dyn BlobDir>,
    base: String,
) -> Result<ImportEntry, api::Error> {
    tx.send(AddProgressItem::Size(data.len() as u64))
        .await
        .map_err(send_err)?;
    tx.send(AddProgressItem::CopyDone).await.map_err(send_err)?;
    let outboard = PreOrderMemOutboard::create(&data, IROH_BLOCK_SIZE);
    let names = (format!("{base}.data"), format!("{base}.out"));
    let data_file = dir.create(&names.0).await.map_err(api::Error::Io)?;
    data_file.write_all_at(0, &data).map_err(api::Error::Io)?;
    let outboard_file = dir.create(&names.1).await.map_err(io_err)?;
    outboard_file
        .write_all_at(0, &outboard.data)
        .map_err(io_err)?;
    data_file.sync().map_err(io_err)?;
    outboard_file.sync().map_err(io_err)?;
    Ok(ImportEntry {
        hash: outboard.root.into(),
        size: data.len() as u64,
        names,
        data: data_file,
        outboard: outboard_file,
        format,
        tx,
    })
}

/// Streamed upload: each chunk is written to the data file as it arrives; the
/// outboard (pre-order layout) is computed by incremental re-read once the
/// stream is done (RAM ≈ O(log n)).
async fn import_byte_stream(
    format: BlobFormat,
    mut rx: irpc::channel::mpsc::Receiver<ImportByteStreamUpdate>,
    tx: irpc::channel::mpsc::Sender<AddProgressItem>,
    dir: Arc<dyn BlobDir>,
    base: String,
) -> Result<ImportEntry, api::Error> {
    let names = (format!("{base}.data"), format!("{base}.out"));
    let data_file = dir.create(&names.0).await.map_err(io_err)?;
    let mut offset: u64 = 0;
    loop {
        match rx.recv().await {
            Ok(Some(ImportByteStreamUpdate::Bytes(bytes))) => {
                data_file.write_all_at(offset, &bytes).map_err(io_err)?;
                offset += bytes.len() as u64;
                tx.send(AddProgressItem::CopyProgress(offset))
                    .await
                    .map_err(send_err)?;
            }
            Ok(Some(ImportByteStreamUpdate::Done) | None) => break,
            Err(err) => return Err(api::Error::Io(io::Error::other(err))),
        }
    }
    if offset == 0 {
        let outboard_file = dir.create(&names.1).await.map_err(io_err)?;
        return Ok(ImportEntry {
            hash: Hash::EMPTY,
            size: 0,
            names,
            data: data_file,
            outboard: outboard_file,
            format,
            tx,
        });
    }
    let tree = BaoTree::new(offset, IROH_BLOCK_SIZE);
    let outboard_file = dir.create(&names.1).await.map_err(io_err)?;
    let mut outboard = bao_tree::io::outboard::PreOrderOutboard {
        root: blake3::hash(&[]),
        tree,
        data: AsyncFileWriter(outboard_file.clone()),
    };
    let reader = FileStreamReader {
        file: data_file.clone(),
        pos: 0,
    };
    let root = fsm::outboard(reader, tree, &mut outboard)
        .await
        .map_err(io_err)?;
    data_file.sync().map_err(io_err)?;
    outboard_file.sync().map_err(io_err)?;
    Ok(ImportEntry {
        hash: root.into(),
        size: offset,
        names,
        data: data_file,
        outboard: outboard_file,
        format,
        tx,
    })
}

/// Download: sparse validated writes into the data/outboard files, bitfield
/// updated as items arrive (observable via `Observe`). Every failure is sent
/// to the caller through `tx`; a partial entry is kept for later resumption.
async fn import_bao(
    entry: Entry,
    size: std::num::NonZeroU64,
    mut stream: irpc::channel::mpsc::Receiver<BaoContentItem>,
    tx: irpc::channel::oneshot::Sender<api::Result<()>>,
) {
    let size = size.get();
    entry.watch.send_if_modified(|bf| {
        bf.update(&Bitfield::new(ChunkRanges::empty(), size))
            .changed()
    });
    let tree = BaoTree::new(size, IROH_BLOCK_SIZE);
    let result: io::Result<()> = async {
        loop {
            let Some(item) = stream.recv().await.map_err(io::Error::other)? else {
                break;
            };
            match item {
                BaoContentItem::Parent(parent) => {
                    if let Some(offset) = tree.pre_order_offset(parent.node) {
                        let mut pair = [0u8; 64];
                        pair[..32].copy_from_slice(parent.pair.0.as_bytes());
                        pair[32..].copy_from_slice(parent.pair.1.as_bytes());
                        entry.outboard.write_all_at(offset * 64, &pair)?;
                    }
                }
                BaoContentItem::Leaf(leaf) => {
                    entry.data.write_all_at(leaf.offset, &leaf.data)?;
                    let added = chunk_range(&leaf);
                    entry
                        .watch
                        .send_if_modified(|bf| bf.update(&Bitfield::new(added, size)).changed());
                }
            }
        }
        Ok(())
    }
    .await;
    match result {
        Ok(()) => tx.send(Ok(())).await.ok(),
        Err(err) => tx.send(Err(api::Error::Io(err))).await.ok(),
    };
}

async fn export_bao(
    entry: Option<Entry>,
    hash: Hash,
    ranges: ChunkRanges,
    mut tx: irpc::channel::mpsc::Sender<EncodedItem>,
) -> Result<(), api::Error> {
    let Some(entry) = entry else {
        tx.send(EncodedItem::from(bao_tree::io::EncodeError::Io(
            io::Error::new(io::ErrorKind::NotFound, "hash not found"),
        )))
        .await
        .ok();
        return Ok(());
    };
    let bitfield = entry.watch.borrow().clone();
    let tree = BaoTree::new(bitfield.size(), IROH_BLOCK_SIZE);
    let data = DataView(entry.data.clone());
    let outboard = OutboardView {
        root: hash.into(),
        tree,
        file: entry.outboard.clone(),
    };
    let mut sender = EncodedSender(&mut tx);
    let _ = traverse_ranges_validated(data, outboard, &ranges, &mut sender).await;
    Ok(())
}

async fn export_ranges(
    cmd: proto::ExportRangesRequest,
    entry: Option<Entry>,
    tx: irpc::channel::mpsc::Sender<ExportRangesItem>,
) -> Result<(), api::Error> {
    let Some(entry) = entry else {
        tx.send(ExportRangesItem::Error(api::Error::other("hash not found")))
            .await
            .ok();
        return Ok(());
    };
    let bitfield = entry.watch.borrow().clone();
    let size = bitfield.size();
    for range in cmd.ranges.iter() {
        let range = match range {
            RangeSetRange::Range(range) => size.min(*range.start)..size.min(*range.end),
            RangeSetRange::RangeFrom(range) => size.min(*range.start)..size,
        };
        let requested = ChunkRanges::bytes(range.start..range.end);
        if !bitfield.ranges.is_superset(&requested) {
            tx.send(ExportRangesItem::Error(api::Error::other(format!(
                "missing range: {requested:?}, present: {bitfield:?}"
            ))))
            .await
            .ok();
            return Ok(());
        }
        let bs: u64 = 1024 * 1024;
        let mut offset = range.start;
        while offset < range.end {
            let end = (offset + bs).min(range.end);
            let bytes = read_exact_at(&entry.data, offset, (end - offset) as usize)?;
            tx.send(ExportRangesItem::Data(bao_tree::io::Leaf {
                offset,
                data: bytes,
            }))
            .await
            .map_err(send_err)?;
            offset = end;
        }
    }
    Ok(())
}

async fn observe(
    entry: Entry,
    tx: irpc::channel::mpsc::Sender<api::proto::Bitfield>,
) -> Result<(), api::Error> {
    let mut rx = entry.watch.subscribe();
    let value = rx.borrow_and_update().clone();
    tx.send(value).await.ok();
    loop {
        if rx.changed().await.is_err() {
            return Ok(());
        }
        let value = rx.borrow_and_update().clone();
        if tx.send(value).await.is_err() {
            return Ok(());
        }
    }
}

// === helpers =================================================================

fn chunk_range(leaf: &bao_tree::io::Leaf) -> ChunkRanges {
    let start = ChunkNum::chunks(leaf.offset);
    let end = ChunkNum::chunks(leaf.offset + leaf.data.len() as u64);
    (start..end).into()
}

fn io_err(err: io::Error) -> api::Error {
    api::Error::Io(err)
}

fn send_err(err: irpc::channel::SendError) -> api::Error {
    api::Error::Io(err.into())
}

/// `mixed::Sender` wrapper over an irpc sender.
struct EncodedSender<'a>(&'a mut irpc::channel::mpsc::Sender<EncodedItem>);

impl bao_tree::io::mixed::Sender for EncodedSender<'_> {
    type Error = irpc::channel::SendError;

    async fn send(&mut self, item: EncodedItem) -> Result<(), Self::Error> {
        self.0.send(item).await
    }
}

/// Byte-wise reads (bao `mixed`) from a backend file.
struct DataView(crate::file::BlobFileImpl);

impl ReadBytesAt for DataView {
    fn read_bytes_at(&self, offset: u64, size: usize) -> io::Result<Bytes> {
        read_exact_at(&self.0, offset, size)
    }
}

/// Read-only outboard over a backend file (iroh pre-order layout).
struct OutboardView {
    root: blake3::Hash,
    tree: BaoTree,
    file: crate::file::BlobFileImpl,
}

impl Outboard for OutboardView {
    fn root(&self) -> blake3::Hash {
        self.root
    }

    fn tree(&self) -> BaoTree {
        self.tree
    }

    fn load(&self, node: TreeNode) -> io::Result<Option<(blake3::Hash, blake3::Hash)>> {
        let Some(offset) = self.tree.pre_order_offset(node) else {
            return Ok(None);
        };
        let bytes = read_exact_at(&self.file, offset * 64, 64)?;
        let (left, right) = bytes.as_ref().split_at(32);
        let left: [u8; 32] = left.try_into().unwrap();
        let right: [u8; 32] = right.try_into().unwrap();
        Ok(Some((blake3::Hash::from(left), blake3::Hash::from(right))))
    }
}

/// Sequential reader over a backend file (`AsyncStreamReader` for
/// `fsm::outboard`).
struct FileStreamReader {
    file: crate::file::BlobFileImpl,
    pos: u64,
}

impl iroh_io::AsyncStreamReader for FileStreamReader {
    async fn read_bytes(&mut self, len: usize) -> io::Result<Bytes> {
        let mut buf = vec![0u8; len];
        let mut done = 0usize;
        while done < len {
            let n = self
                .file
                .read_at(self.pos + done as u64, &mut buf[done..])?;
            if n == 0 {
                break;
            }
            done += n;
        }
        self.pos += done as u64;
        buf.truncate(done);
        Ok(buf.into())
    }

    async fn read<const L: usize>(&mut self) -> io::Result<[u8; L]> {
        let bytes = self.read_bytes_exact(L).await?;
        bytes
            .as_ref()
            .try_into()
            .map_err(|_| io::Error::new(io::ErrorKind::UnexpectedEof, "short read"))
    }
}

/// Async write wrapper over a backend file (for the incremental outboard
/// during upload).
struct AsyncFileWriter(crate::file::BlobFileImpl);

impl iroh_io::AsyncSliceWriter for AsyncFileWriter {
    async fn write_at(&mut self, offset: u64, data: &[u8]) -> io::Result<()> {
        self.0.write_all_at(offset, data)
    }

    async fn write_bytes_at(&mut self, offset: u64, data: Bytes) -> io::Result<()> {
        self.0.write_all_at(offset, &data)
    }

    async fn set_len(&mut self, len: u64) -> io::Result<()> {
        BlobFile::set_len(&self.0, len)
    }

    async fn sync(&mut self) -> io::Result<()> {
        self.0.sync()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use n0_future::StreamExt;

    type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

    fn test_store() -> api::Store {
        LocalStore::new_with_opts(Options::default()).into()
    }

    /// Reference bao encoding (size + parents + leaves) using `bao_tree`'s
    /// synchronous APIs.
    fn reference_bao(data: &[u8], ranges: &ChunkRanges) -> (Hash, Vec<u8>) {
        let outboard = PreOrderMemOutboard::create(data, IROH_BLOCK_SIZE);
        let mut encoded = Vec::new();
        encoded.extend_from_slice(&(data.len() as u64).to_le_bytes());
        bao_tree::io::sync::encode_ranges_validated(data, &outboard, ranges, &mut encoded)
            .map_err(|e| -> io::Error { io::Error::other(e.to_string()) })
            .unwrap();
        (outboard.root.into(), encoded)
    }

    /// Collects the full `export_bao` stream into bytes.
    async fn collect_export(store: &api::Store, hash: Hash) -> Vec<u8> {
        let mut stream = store.export_bao(hash, ChunkRanges::all()).stream();
        let mut out = Vec::new();
        while let Some(item) = stream.next().await {
            match item {
                EncodedItem::Size(size) => out.extend_from_slice(&size.to_le_bytes()),
                EncodedItem::Parent(parent) => {
                    out.extend_from_slice(parent.pair.0.as_bytes());
                    out.extend_from_slice(parent.pair.1.as_bytes());
                }
                EncodedItem::Leaf(leaf) => out.extend_from_slice(&leaf.data),
                EncodedItem::Error(e) => panic!("export error: {e}"),
                EncodedItem::Done => break,
            }
        }
        out
    }

    #[tokio::test]
    async fn add_bytes_round_trip() -> TestResult {
        let store = test_store();
        let data = vec![7u8; 100_000];
        let hash = store.add_bytes(data.clone()).temp_tag().await?.hash();
        assert!(matches!(
            store.status(hash).await?,
            BlobStatus::Complete { size: 100_000 }
        ));

        // export + reimport into a second store, read + compare
        let bao = collect_export(&store, hash).await;
        let (_, reference) = reference_bao(&data, &ChunkRanges::all());
        assert_eq!(bao, reference);

        let store2 = test_store();
        store2
            .import_bao_bytes(hash, ChunkRanges::all(), bao)
            .await?;
        assert!(matches!(
            store2.status(hash).await?,
            BlobStatus::Complete { size: 100_000 }
        ));
        let bytes = store2.get_bytes(hash).await?;
        assert_eq!(bytes.as_ref(), &data);
        Ok(())
    }

    #[tokio::test]
    async fn stream_import_matches_reference() -> TestResult {
        let store = test_store();
        let chunk1 = vec![1u8; 100 * 1024];
        let chunk2 = vec![2u8; 7];
        let chunk3 = vec![3u8; 33];
        let mut concat = chunk1.clone();
        concat.extend_from_slice(&chunk2);
        concat.extend_from_slice(&chunk3);

        let stream = n0_future::stream::iter(
            [chunk1, chunk2, chunk3]
                .into_iter()
                .map(|b| Ok::<_, io::Error>(Bytes::from(b))),
        );
        let tag = store.blobs().add_stream(stream).await.temp_tag().await?;
        let (hash_ref, bao_ref) = reference_bao(&concat, &ChunkRanges::all());
        assert_eq!(tag.hash(), hash_ref);
        let exported = collect_export(&store, tag.hash()).await;
        assert_eq!(exported, bao_ref);
        Ok(())
    }

    #[tokio::test]
    async fn full_import_no_partial() -> TestResult {
        let data: Vec<u8> = (0..200_000u32).map(|i| i as u8).collect();
        let (hash, bao) = reference_bao(&data, &ChunkRanges::all());
        let store = test_store();
        store
            .import_bao_bytes(hash, ChunkRanges::all(), bao)
            .await?;
        let bytes = store.get_bytes(hash).await?;
        assert_eq!(bytes.as_ref(), &data);
        Ok(())
    }

    #[tokio::test]
    async fn partial_import_file_layout() -> TestResult {
        use crate::file::MemDir;
        let dir = Arc::new(MemDir::new());
        let store: api::Store = LocalStore::new_with_opts(Options {
            dir: Some(dir.clone()),
            storage_check: None,
        })
        .into();
        let data: Vec<u8> = (0..200_000u32).map(|i| i as u8).collect();
        let outboard = PreOrderMemOutboard::create(&data, IROH_BLOCK_SIZE);
        let hash: Hash = outboard.root.into();
        let mut bao = Vec::new();
        bao.extend_from_slice(&(data.len() as u64).to_le_bytes());
        bao_tree::io::sync::encode_ranges_validated(
            &data,
            &outboard,
            &ChunkRanges::all(),
            &mut bao,
        )
        .map_err(|e| io::Error::other(e.to_string()))?;
        // encode the subset (chunk 0 only)
        let mut bao_partial = Vec::new();
        bao_partial.extend_from_slice(&(data.len() as u64).to_le_bytes());
        bao_tree::io::sync::encode_ranges_validated(
            &data,
            &outboard,
            &ChunkRanges::from(..ChunkNum(1)),
            &mut bao_partial,
        )
        .map_err(|e| io::Error::other(e.to_string()))?;

        store
            .import_bao_bytes(hash, ChunkRanges::from(..ChunkNum(1)), bao_partial)
            .await?;
        let partial_out = dir.contents(&format!("{hash}.out"));
        // partial outboard: strict prefix of the reference outboard (sparse writes)
        assert!(
            !partial_out.is_empty()
                && partial_out.len() <= outboard.data.len()
                && partial_out.as_slice() == &outboard.data[..partial_out.len()],
            "invalid partial outboard: len={} ref={}",
            partial_out.len(),
            outboard.data.len()
        );

        store
            .import_bao_bytes(hash, ChunkRanges::all(), bao)
            .await?;
        let full_out = dir.contents(&format!("{hash}.out"));
        // full outboard: byte-identical to the reference outboard
        assert_eq!(full_out, outboard.data);
        let full_data = dir.contents(&format!("{hash}.data"));
        assert_eq!(full_data, data);
        Ok(())
    }

    #[tokio::test]
    async fn partial_import_and_observe() -> TestResult {
        let data: Vec<u8> = (0..200_000u32).map(|i| i as u8).collect();
        let (hash, bao) = reference_bao(&data, &ChunkRanges::all());
        let outboard = PreOrderMemOutboard::create(&data, IROH_BLOCK_SIZE);
        let mut bao_partial = Vec::new();
        bao_partial.extend_from_slice(&(data.len() as u64).to_le_bytes());
        bao_tree::io::sync::encode_ranges_validated(
            &data,
            &outboard,
            &ChunkRanges::from(..ChunkNum(1)),
            &mut bao_partial,
        )
        .map_err(|e| io::Error::other(e.to_string()))?;

        let store = test_store();
        let mut observed = store.observe(hash).stream().await?;
        let watcher = n0_future::task::spawn(async move {
            while let Some(bitfield) = observed.next().await {
                if bitfield.is_complete() {
                    return;
                }
            }
        });

        // partial import: first chunk only
        store
            .import_bao_bytes(hash, ChunkRanges::from(..ChunkNum(1)), bao_partial)
            .await?;
        let status = store.status(hash).await?;
        assert!(matches!(status, BlobStatus::Partial { size: Some(_) }));

        // completion
        store
            .import_bao_bytes(hash, ChunkRanges::all(), bao)
            .await?;
        assert!(matches!(
            store.status(hash).await?,
            BlobStatus::Complete { size: 200_000 }
        ));
        let bytes = store.get_bytes(hash).await?;
        assert_eq!(bytes.as_ref(), &data);

        // the observe stream did see the complete state (otherwise panic in the timeout)
        tokio::time::timeout(std::time::Duration::from_secs(5), watcher)
            .await
            .map_err(|_| -> io::Error { io::Error::other("observe never completed") })??;
        Ok(())
    }

    #[tokio::test]
    async fn empty_blob_round_trip() -> TestResult {
        let store = test_store();
        let tag = store.add_bytes(Vec::new()).temp_tag().await?;
        assert_eq!(tag.hash(), Hash::EMPTY);
        let exported = collect_export(&store, Hash::EMPTY).await;
        assert_eq!(exported, 0u64.to_le_bytes());
        let bytes = store.get_bytes(Hash::EMPTY).await?;
        assert!(bytes.is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn storage_check_rejects_oversized() -> TestResult {
        use crate::file::MemDir;
        let limit: u64 = 64 * 1024;
        let check: StorageCheck = Arc::new(move |size| {
            Box::pin(async move {
                if size > limit {
                    Err("too large".to_string())
                } else {
                    Ok(())
                }
            })
        });
        let dir = Arc::new(MemDir::new());
        let store: api::Store = LocalStore::new_with_opts(Options {
            dir: Some(dir.clone()),
            storage_check: Some(check),
        })
        .into();

        let data = vec![9u8; 128 * 1024];
        let (hash, bao) = reference_bao(&data, &ChunkRanges::all());

        // rejection: size > quota, and nothing is left behind
        let err = store
            .import_bao_bytes(hash, ChunkRanges::all(), bao.clone())
            .await;
        assert!(err.is_err(), "expected quota rejection");
        assert!(matches!(store.status(hash).await?, BlobStatus::NotFound));
        assert!(dir.contents(&format!("{hash}.data")).is_empty());
        assert!(dir.contents(&format!("{hash}.out")).is_empty());

        // accepted under the limit
        let small = vec![1u8; 1024];
        let (hash2, bao2) = reference_bao(&small, &ChunkRanges::all());
        store
            .import_bao_bytes(hash2, ChunkRanges::all(), bao2)
            .await?;
        assert!(matches!(
            store.status(hash2).await?,
            BlobStatus::Complete { size: 1024 }
        ));
        let _ = data;
        Ok(())
    }
}

//! WASM bindings exposed to the TypeScript frontend.
//!
//! Phase 2: large files through the OPFS store.
//! - upload: `import_begin` / `import_chunk` / `import_finish` (`File.slice`
//!   chunks streamed into OPFS, outboard computed incrementally);
//! - download: `download` (sparse validated writes) then `save_file`
//!   (OPFS handle → JS `File`, zero heap copy);
//! - text: `import` / `get` kept from the phase 1 spike.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex, OnceLock,
    },
};

use bytes::Bytes;
use iroh_blobs::{ticket::BlobTicket, Hash};
use js_sys::Uint8Array;
use tokio::sync::mpsc;
use tracing::level_filters::LevelFilter;
use tracing_subscriber_wasm::MakeConsoleWriter;
use wasm_bindgen::{prelude::wasm_bindgen, JsCast, JsError, JsValue};
use wasm_bindgen_futures::JsFuture;

use crate::{
    file::{js_error, OpfsDir},
    store::{LocalStore, Options, StorageCheck},
};

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
    tracing_subscriber::fmt()
        .with_max_level(LevelFilter::INFO)
        .with_writer(MakeConsoleWriter::default().map_trace_level_to(tracing::Level::DEBUG))
        .without_time()
        .with_ansi(false)
        .init();
}

/// Crate version, handy to check the WASM/UI pairing.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// ==== in-progress streamed imports ==========================================

struct PendingImport {
    tx: mpsc::Sender<iroh_blobs::api::proto::ImportByteStreamUpdate>,
    /// Bytes received so far (for progress).
    copied: Arc<Mutex<u64>>,
    result: tokio::sync::oneshot::Receiver<Result<Hash, String>>,
    #[allow(dead_code)]
    name: String,
}

fn next_import_id() -> u32 {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    NEXT.fetch_add(1, Ordering::SeqCst)
}

fn pending_imports() -> &'static Mutex<HashMap<u32, PendingImport>> {
    static PENDING: OnceLock<Mutex<HashMap<u32, PendingImport>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// JS chunk flow → `Stream` for `add_stream`.
struct ChunkStream(mpsc::Receiver<iroh_blobs::api::proto::ImportByteStreamUpdate>);

impl n0_future::Stream for ChunkStream {
    type Item = std::io::Result<Bytes>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        use std::task::Poll;
        match self.0.poll_recv(cx) {
            Poll::Ready(Some(update)) => match update {
                iroh_blobs::api::proto::ImportByteStreamUpdate::Bytes(bytes) => {
                    Poll::Ready(Some(Ok(bytes)))
                }
                iroh_blobs::api::proto::ImportByteStreamUpdate::Done => Poll::Ready(None),
            },
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

/// Quota check: reject if `size` does not fit in the remaining OPFS quota
/// (10% margin + 64 MiB for the outboard and temporaries).
fn storage_check_closure() -> StorageCheck {
    Arc::new(move |size: u64| Box::pin(async move { check_storage(size).await }))
}

async fn check_storage(size: u64) -> Result<(), String> {
    let (usage, quota) = opfs_estimate().await?;
    let Some(quota) = quota else {
        // unknown quota: cannot decide, let it through
        return Ok(());
    };
    let margin = size / 10 + 64 * 1024 * 1024;
    let needed = size.saturating_add(margin);
    let available = quota.saturating_sub(usage.unwrap_or(0));
    if needed > available {
        return Err(format!(
            "insufficient space: {:.1} GiB needed, {:.1} GiB available in site storage",
            needed as f64 / 1024.0 / 1024.0 / 1024.0,
            available as f64 / 1024.0 / 1024.0 / 1024.0,
        ));
    }
    Ok(())
}

/// `(usage, quota)` of the site's OPFS storage, in bytes.
async fn opfs_estimate() -> Result<(Option<u64>, Option<u64>), String> {
    let estimate = JsFuture::from(
        js_sys::global()
            .unchecked_into::<web_sys::WorkerGlobalScope>()
            .navigator()
            .storage()
            .estimate()
            .map_err(|e| format!("{e:?}"))?,
    )
    .await
    .map_err(js_error)?;
    let estimate: web_sys::StorageEstimate = estimate.unchecked_into();
    Ok((
        estimate.get_usage().map(|v| v as u64),
        estimate.get_quota().map(|v| v as u64),
    ))
}

/// Sendblob node in the browser.
#[wasm_bindgen]
pub struct BlobsNode {
    node: crate::node::BlobsNode,
    local: LocalStore,
}

#[wasm_bindgen]
impl BlobsNode {
    /// Spawns a node backed by the OPFS store, in the `sendblob/<subdir>`
    /// directory (one subdirectory per browser tab).
    pub async fn spawn(subdir: String) -> Result<BlobsNode, JsError> {
        // The OPFS directory purge is done on the TS side before the call; here
        // we open the directory and wire the custom store.
        let dir = OpfsDir::open(&subdir)
            .await
            .map_err(|e| JsError::new(&e.to_string()))?;
        let store = LocalStore::new_with_opts(Options {
            dir: Some(Arc::new(dir)),
            storage_check: Some(storage_check_closure()),
        });
        let node = crate::node::BlobsNode::spawn_with_store(store.clone().into())
            .await
            .map_err(to_js_err)?;
        Ok(Self { node, local: store })
    }

    /// Identifier of the local endpoint.
    pub fn endpoint_id(&self) -> String {
        self.node.endpoint_id().to_string()
    }

    /// Imports bytes, returns the ticket (texts and small blobs).
    pub async fn import(&self, data: Uint8Array) -> Result<String, JsError> {
        let data = uint8array_to_bytes(&data);
        tracing::info!("importing data of len {}", data.len());
        let tag = self
            .node
            .blobs
            .add_bytes(data)
            .temp_tag()
            .await
            .map_err(to_js_err)?;
        let hash = tag.hash();
        drop(tag);
        let ticket = self
            .node
            .ticket(hash, iroh_blobs::BlobFormat::Raw)
            .await
            .map_err(to_js_err)?;
        Ok(ticket.to_string())
    }

    /// Starts a streamed import, returns the id to pass to
    /// `import_chunk` / `import_finish` / `import_progress`.
    pub async fn import_begin(&self, name: String, size: f64) -> Result<u32, JsError> {
        // Pre-check the quota before pushing a single byte (the store only
        // checks the network path import_bao, not add_stream).
        let size = size as u64;
        check_storage(size).await.map_err(|e| JsError::new(&e))?;
        let (tx, rx) = mpsc::channel(8);
        let copied = Arc::new(Mutex::new(0u64));
        let (result_tx, result_rx) = tokio::sync::oneshot::channel();
        let id = next_import_id();

        // Consumer task: add_stream writes the chunks into OPFS as they
        // arrive and ends with Done(hash).
        let store: iroh_blobs::api::Store = self.local.clone().into();
        let copied_task = copied.clone();
        n0_future::task::spawn(async move {
            use n0_future::StreamExt;
            let progress = store.blobs().add_stream(ChunkStream(rx));
            let mut result: Result<Hash, String> = Err("interrupted".to_string());
            let mut stream = progress.await.stream().await;
            while let Some(item) = stream.next().await {
                match item {
                    iroh_blobs::api::proto::AddProgressItem::CopyProgress(offset) => {
                        *copied_task.lock().unwrap() = offset;
                    }
                    iroh_blobs::api::proto::AddProgressItem::Done(tag) => {
                        result = Ok(tag.hash());
                        break;
                    }
                    iroh_blobs::api::proto::AddProgressItem::Error(err) => {
                        result = Err(err.to_string());
                        break;
                    }
                    _ => {}
                }
            }
            let _ = result_tx.send(result);
        });

        pending_imports().lock().unwrap().insert(
            id,
            PendingImport {
                tx,
                copied,
                result: result_rx,
                name,
            },
        );
        Ok(id)
    }

    /// Pushes a chunk of an in-progress import.
    pub async fn import_chunk(&self, id: u32, data: Uint8Array) -> Result<(), JsError> {
        let pending = pending_imports()
            .lock()
            .unwrap()
            .get(&id)
            .map(|p| (p.tx.clone(), p.copied.clone()));
        let Some((tx, copied)) = pending else {
            return Err(JsError::new("unknown or finished import"));
        };
        let bytes = uint8array_to_bytes(&data);
        *copied.lock().unwrap() += bytes.len() as u64;
        tx.send(iroh_blobs::api::proto::ImportByteStreamUpdate::Bytes(bytes))
            .await
            .map_err(|_| JsError::new("import interrupted"))?;
        Ok(())
    }

    /// Finishes the import: waits for the hash, returns the ticket.
    pub async fn import_finish(&self, id: u32) -> Result<String, JsError> {
        let Some(pending) = pending_imports().lock().unwrap().remove(&id) else {
            return Err(JsError::new("unknown or already finished import"));
        };
        let _ = pending
            .tx
            .send(iroh_blobs::api::proto::ImportByteStreamUpdate::Done)
            .await;
        let hash = pending
            .result
            .await
            .map_err(|_| JsError::new("import interrupted"))?
            .map_err(|e| JsError::new(&e))?;
        let ticket = self
            .node
            .ticket(hash, iroh_blobs::BlobFormat::Raw)
            .await
            .map_err(to_js_err)?;
        Ok(ticket.to_string())
    }

    /// Aborts an in-progress import (temporary files stay until the next
    /// purge).
    pub async fn import_abort(&self, id: u32) {
        if let Some(pending) = pending_imports().lock().unwrap().remove(&id) {
            // dropping the sender: the stream ends, the import fails
            drop(pending.tx);
        }
    }

    /// Bytes copied so far for an in-progress import.
    pub fn import_progress(&self, id: u32) -> f64 {
        pending_imports()
            .lock()
            .unwrap()
            .get(&id)
            .map(|p| *p.copied.lock().unwrap() as f64)
            .unwrap_or(0.0)
    }

    /// Downloads from a ticket, returns the hash at completion.
    pub async fn download(&self, ticket: String) -> Result<String, JsError> {
        let ticket: BlobTicket = ticket.parse().map_err(to_js_err)?;
        let hash = self.node.download(ticket).await.map_err(to_js_err)?;
        Ok(hash.to_string())
    }

    /// Hash extracted from a ticket, without starting a download (for progress).
    pub fn hash_from_ticket(&self, ticket: String) -> Result<String, JsError> {
        let ticket: BlobTicket = ticket.parse().map_err(to_js_err)?;
        Ok(ticket.hash().to_string())
    }

    /// Blob status: "not_found", "partial:<bytes received>", "complete:<size>".
    pub async fn status(&self, hash: String) -> Result<String, JsError> {
        let hash: Hash = hash.parse().map_err(to_js_err)?;
        let status = self.node.blobs.status(hash).await.map_err(to_js_err)?;
        Ok(match status {
            iroh_blobs::api::blobs::BlobStatus::NotFound => "not_found".to_string(),
            iroh_blobs::api::blobs::BlobStatus::Partial { size } => {
                format!("partial:{}", size.unwrap_or(0))
            }
            iroh_blobs::api::blobs::BlobStatus::Complete { size } => format!("complete:{size}"),
        })
    }

    /// Bytes of the downloaded blob (text spike only).
    pub async fn get(&self, hash: String) -> Result<Uint8Array, JsError> {
        let hash: Hash = hash.parse().map_err(to_js_err)?;
        let bytes = self.node.get_bytes(hash).await.map_err(to_js_err)?;
        Ok(bytes_to_uint8array(&bytes))
    }

    /// Size of the complete blob (0 if absent).
    pub async fn blob_size(&self, hash: String) -> Result<f64, JsError> {
        let hash: Hash = hash.parse().map_err(to_js_err)?;
        let status = self.node.blobs.status(hash).await.map_err(to_js_err)?;
        Ok(match status {
            iroh_blobs::api::blobs::BlobStatus::Complete { size } => size as f64,
            _ => 0.0,
        })
    }

    /// OPFS handle (`FileSystemFileHandle`) of the downloaded blob, for
    /// zero-copy saving on the JS side (`getFile()` → Blob backed by OPFS).
    pub fn save_file(&self, hash: String) -> Result<JsValue, JsError> {
        let hash: Hash = hash.parse().map_err(to_js_err)?;
        let file = self
            .local
            .data_file(&hash)
            .ok_or_else(|| JsError::new("blob not found"))?;
        Ok(file.file_handle().clone().into())
    }

    /// `(usage, quota)` of the site's storage, for the UI.
    pub async fn storage_estimate(&self) -> Result<JsValue, JsError> {
        let (usage, quota) = opfs_estimate().await.map_err(|e| JsError::new(&e))?;
        let obj = js_sys::Object::new();
        let set = |key: &str, value: f64| -> Result<(), JsValue> {
            js_sys::Reflect::set(&obj, &key.into(), &JsValue::from_f64(value)).map(|_| ())
        };
        set("usage", usage.unwrap_or(0) as f64)
            .and_then(|_| set("quota", quota.unwrap_or(0) as f64))
            .map_err(|_| JsError::new("storage estimate failed"))?;
        Ok(obj.into())
    }
}

/// Converts an error into a JS error carrying its display message.
fn to_js_err(err: impl Into<anyhow::Error>) -> JsError {
    let err: anyhow::Error = err.into();
    JsError::new(&err.to_string())
}

/// Copies a `Uint8Array` into a `Bytes`.
pub fn uint8array_to_bytes(data: &Uint8Array) -> Bytes {
    let mut buffer = vec![0u8; data.length() as usize];
    data.copy_to(&mut buffer[..]);
    Bytes::from(buffer)
}

/// Copies bytes into a new `Uint8Array`.
pub fn bytes_to_uint8array(bytes: &[u8]) -> Uint8Array {
    let array = Uint8Array::new_with_length(bytes.len() as u32);
    array.copy_from(bytes);
    array
}

//! File storage backend for the local store.
//!
//! Two implementations behind the same [`BlobFile`] trait:
//! - wasm: OPFS via `FileSystemSyncAccessHandle` (synchronous, available in
//!   the worker where the WASM runs);
//! - native: in-memory file, for the shared store tests.
//!
//! Storage is *sparse* by construction: writes at arbitrary offsets extend
//! the file (implicit zeros), which matches the progressive assembly of a
//! bao download.
//!
//! [`BlobDir`] and [`DirFut`] are deliberately duplicated per target instead
//! of being cfg'd through a helper trait: natively, `Arc<dyn BlobDir>` and
//! the boxed futures must carry `+ Send` markers to cross `tokio::spawn`,
//! and `dyn` auto-trait bounds cannot be injected through a cfg'd supertrait
//! on the object type.

use std::{future::Future, io, pin::Pin};

use bytes::Bytes;

/// Future returned by the asynchronous operations of a [`BlobDir`].
///
/// `Send` only on the native side (tokio requires it for `spawn`); on wasm
/// the futures carry `JsValue`s and are not `Send`.
#[cfg(not(target_arch = "wasm32"))]
pub type DirFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
/// Future returned by the asynchronous operations of a [`BlobDir`].
///
/// `Send` only on the native side (tokio requires it for `spawn`); on wasm
/// the futures carry `JsValue`s and are not `Send`.
#[cfg(target_arch = "wasm32")]
pub type DirFut<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// File namespace: creation/removal by name.
///
/// Abstraction over an OPFS directory (wasm) or an in-memory directory (tests).
#[cfg(not(target_arch = "wasm32"))]
pub trait BlobDir: Send + Sync + 'static {
    /// Creates (or opens) the file `name`.
    fn create(&self, name: &str) -> DirFut<'_, io::Result<BlobFileImpl>>;
    /// Removes the file `name` if it exists.
    fn remove(&self, name: &str) -> DirFut<'_, io::Result<()>>;
}
/// File namespace: creation/removal by name.
///
/// Abstraction over an OPFS directory (wasm) or an in-memory directory (tests).
#[cfg(target_arch = "wasm32")]
pub trait BlobDir: 'static {
    /// Creates (or opens) the file `name`.
    fn create(&self, name: &str) -> DirFut<'_, io::Result<BlobFileImpl>>;
    /// Removes the file `name` if it exists.
    fn remove(&self, name: &str) -> DirFut<'_, io::Result<()>>;
}

/// Storage file (data or outboard) of a blob.
pub trait BlobFile: Clone + 'static {
    /// Reads at most `buf.len()` bytes at `offset`, returns the number read.
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> io::Result<usize>;
    /// Writes all of `buf` at `offset` (loops over short writes).
    fn write_all_at(&self, offset: u64, buf: &[u8]) -> io::Result<()>;
    /// Truncates or extends the file to `len`.
    fn set_len(&self, len: u64) -> io::Result<()>;
    /// Flushes pending writes to durable storage.
    fn sync(&self) -> io::Result<()>;
    /// Closes the underlying handle, releasing OPFS locks.
    fn close(&self);
}

/// Reads exactly `size` bytes at `offset` (errors on premature EOF).
pub fn read_exact_at(file: &impl BlobFile, offset: u64, size: usize) -> io::Result<Bytes> {
    let mut buf = vec![0u8; size];
    let mut done = 0usize;
    while done < size {
        let n = file.read_at(offset + done as u64, &mut buf[done..])?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "short read from blob file",
            ));
        }
        done += n;
    }
    Ok(buf.into())
}

#[cfg(not(target_arch = "wasm32"))]
pub use native::{BlobFileImpl, MemDir};
#[cfg(target_arch = "wasm32")]
pub use wasm::{BlobFileImpl, OpfsDir, OpfsFile, js_error};

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use super::{BlobDir, BlobFile, DirFut};
    use std::{
        collections::HashMap,
        io,
        sync::{Arc, Mutex},
    };

    /// In-memory file (native implementation, for the store tests).
    #[derive(Clone, Default, Debug)]
    pub struct MemFile(Arc<Mutex<Vec<u8>>>);

    impl BlobFile for MemFile {
        fn read_at(&self, offset: u64, buf: &mut [u8]) -> io::Result<usize> {
            let file = self.0.lock().unwrap();
            let start = (offset as usize).min(file.len());
            let n = buf.len().min(file.len() - start);
            buf[..n].copy_from_slice(&file[start..start + n]);
            Ok(n)
        }

        fn write_all_at(&self, offset: u64, buf: &[u8]) -> io::Result<()> {
            let mut file = self.0.lock().unwrap();
            let end = offset as usize + buf.len();
            if file.len() < end {
                file.resize(end, 0);
            }
            file[offset as usize..end].copy_from_slice(buf);
            Ok(())
        }

        fn set_len(&self, len: u64) -> io::Result<()> {
            self.0.lock().unwrap().resize(len as usize, 0);
            Ok(())
        }

        fn sync(&self) -> io::Result<()> {
            Ok(())
        }

        fn close(&self) {}
    }

    /// In-memory directory (native implementation, for the store tests).
    #[derive(Default)]
    pub struct MemDir(Mutex<HashMap<String, MemFile>>);

    impl MemDir {
        /// Creates an empty in-memory directory (native store tests).
        pub fn new() -> Self {
            Self::default()
        }

        /// Raw contents of a file (tests).
        #[cfg(test)]
        pub fn contents(&self, name: &str) -> Vec<u8> {
            use super::BlobFile;
            let files = self.0.lock().unwrap();
            let Some(file) = files.get(name) else {
                return Vec::new();
            };
            let mut buf = vec![0u8; 4 * 1024 * 1024];
            let n = file.read_at(0, &mut buf).unwrap_or(0);
            buf.truncate(n);
            buf
        }
    }

    impl BlobDir for MemDir {
        fn create(&self, name: &str) -> DirFut<'_, io::Result<BlobFileImpl>> {
            let file = self
                .0
                .lock()
                .unwrap()
                .entry(name.to_owned())
                .or_default()
                .clone();
            Box::pin(async move { Ok(file) })
        }

        fn remove(&self, name: &str) -> DirFut<'_, io::Result<()>> {
            self.0.lock().unwrap().remove(name);
            Box::pin(async move { Ok(()) })
        }
    }

    /// Concrete [`BlobFile`] implementation (in-memory files natively).
    pub type BlobFileImpl = MemFile;
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::{BlobDir, BlobFile, DirFut};
    use std::io;
    use wasm_bindgen::{JsCast, JsValue};
    use wasm_bindgen_futures::JsFuture;
    use web_sys::{
        FileSystemDirectoryHandle, FileSystemFileHandle, FileSystemGetDirectoryOptions,
        FileSystemGetFileOptions, FileSystemReadWriteOptions, FileSystemSyncAccessHandle,
    };

    fn io_err(err: JsValue) -> io::Error {
        io::Error::other(format!("opfs: {err:?}"))
    }

    fn at_options(at: u64) -> FileSystemReadWriteOptions {
        let opts = FileSystemReadWriteOptions::new();
        opts.set_at(at as f64);
        opts
    }

    /// OPFS file: file handle (for `getFile()` on the JS side) + sync
    /// access handle (direct reads/writes from the WASM).
    #[derive(Clone)]
    pub struct OpfsFile {
        file_handle: FileSystemFileHandle,
        access: FileSystemSyncAccessHandle,
    }

    impl OpfsFile {
        /// Raw OPFS handle, transferable to the main thread for `getFile()`.
        pub fn file_handle(&self) -> &FileSystemFileHandle {
            &self.file_handle
        }
    }

    impl BlobFile for OpfsFile {
        fn read_at(&self, offset: u64, buf: &mut [u8]) -> io::Result<usize> {
            let mut done = 0usize;
            while done < buf.len() {
                let n = self
                    .access
                    .read_with_u8_array_and_options(
                        &mut buf[done..],
                        &at_options(offset + done as u64),
                    )
                    .map_err(io_err)? as usize;
                if n == 0 {
                    break;
                }
                done += n;
            }
            Ok(done)
        }

        fn write_all_at(&self, offset: u64, buf: &[u8]) -> io::Result<()> {
            let mut done = 0usize;
            while done < buf.len() {
                let n = self
                    .access
                    .write_with_u8_array_and_options(
                        &buf[done..],
                        &at_options(offset + done as u64),
                    )
                    .map_err(io_err)? as usize;
                if n == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "opfs: write made no progress",
                    ));
                }
                done += n;
            }
            Ok(())
        }

        fn set_len(&self, len: u64) -> io::Result<()> {
            self.access.truncate_with_f64(len as f64).map_err(io_err)
        }

        fn sync(&self) -> io::Result<()> {
            self.access.flush().map_err(io_err)
        }

        fn close(&self) {
            self.access.close();
        }
    }

    /// OPFS directory (`navigator.storage.getDirectory()/sendblob/<subdir>`).
    #[derive(Clone)]
    pub struct OpfsDir(FileSystemDirectoryHandle);

    impl OpfsDir {
        /// Opens (or creates) the `sendblob/<subdir>` directory of the OPFS
        /// root. One subdirectory per browser tab: OPFS sync access handles
        /// are exclusive, so tabs sharing a directory would conflict.
        pub async fn open(subdir: &str) -> io::Result<Self> {
            let root: FileSystemDirectoryHandle = JsFuture::from(
                js_sys::global()
                    .unchecked_into::<web_sys::WorkerGlobalScope>()
                    .navigator()
                    .storage()
                    .get_directory(),
            )
            .await
            .map_err(io_err)?
            .unchecked_into();
            let opts = FileSystemGetDirectoryOptions::new();
            opts.set_create(true);
            let dir: FileSystemDirectoryHandle =
                JsFuture::from(root.get_directory_handle_with_options("sendblob", &opts))
                    .await
                    .map_err(io_err)?
                    .unchecked_into();
            let dir: FileSystemDirectoryHandle =
                JsFuture::from(dir.get_directory_handle_with_options(subdir, &opts))
                    .await
                    .map_err(io_err)?
                    .unchecked_into();
            Ok(Self(dir))
        }
    }

    impl BlobDir for OpfsDir {
        fn create(&self, name: &str) -> DirFut<'_, io::Result<BlobFileImpl>> {
            let dir = self.0.clone();
            let name = name.to_owned();
            Box::pin(async move {
                let opts = FileSystemGetFileOptions::new();
                opts.set_create(true);
                let file_handle: FileSystemFileHandle =
                    JsFuture::from(dir.get_file_handle_with_options(&name, &opts))
                        .await
                        .map_err(io_err)?
                        .unchecked_into();
                let access: FileSystemSyncAccessHandle =
                    JsFuture::from(file_handle.create_sync_access_handle())
                        .await
                        .map_err(io_err)?
                        .unchecked_into();
                Ok(OpfsFile {
                    file_handle,
                    access,
                })
            })
        }

        fn remove(&self, name: &str) -> DirFut<'_, io::Result<()>> {
            let dir = self.0.clone();
            let name = name.to_owned();
            Box::pin(async move {
                let _ = JsFuture::from(dir.remove_entry(&name)).await;
                Ok(())
            })
        }
    }

    /// Converts a `JsValue` into a readable error message.
    pub fn js_error(err: JsValue) -> String {
        err.as_string().unwrap_or_else(|| format!("{err:?}"))
    }

    /// Concrete [`BlobFile`] implementation (OPFS files on wasm).
    pub type BlobFileImpl = OpfsFile;
}

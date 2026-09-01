//! Core logic shared between the WASM build (browser) and the native CLI.
//!
//! [`BlobsNode`] sets up an iroh endpoint (N0 presets: public relays +
//! DNS/pkarr), an iroh-blobs store and the blobs protocol router. Modeled
//! after the n0-computer/iroh-examples/browser-blobs example.

use anyhow::{anyhow, Result};
use bytes::Bytes;
use iroh::{address_lookup::MemoryLookup, protocol::Router, Endpoint, EndpointId};
use iroh_blobs::{
    api::{blobs::BlobStatus, downloader::Downloader, Store},
    ticket::BlobTicket,
    BlobFormat, BlobsProtocol, Hash,
};

/// Application-level ALPN identifier for sendblob (reserved, unused in the
/// spike: browser↔CLI interop goes through the standard iroh-blobs ALPN).
pub const ALPN: &[u8] = b"sendblob/blobs/0";

/// Target maximum file size for V1 (2 GiB) with the future OPFS store.
pub const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024 * 1024;

/// Size of the chunks used to stream a file into the store (4 MiB).
pub const CHUNK_SIZE: u32 = 4 * 1024 * 1024;

/// High-level states of a sendblob node, exposed to the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeStatus {
    /// The node is not started.
    Idle,
    /// The iroh endpoint is binding.
    Connecting,
    /// The node is online and ready to transfer.
    Ready,
    /// A transfer is in progress.
    Transferring,
    /// The node is shut down.
    Closed,
}

/// A sendblob node: iroh endpoint + blob store + protocol router.
#[derive(Debug, Clone)]
pub struct BlobsNode {
    address_lookup: MemoryLookup,
    router: Router,
    /// Client of the blobs API, to talk to the store directly.
    pub blobs: Store,
    downloader: Downloader,
}

impl BlobsNode {
    /// Spawns a node with the platform's default store
    /// (memory natively, OPFS in the browser).
    pub async fn spawn() -> Result<Self> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let store = iroh_blobs::store::mem::MemStore::default();
            Self::spawn_with_store(store.as_ref().clone()).await
        }
        #[cfg(target_arch = "wasm32")]
        {
            let store = crate::store::LocalStore::new_with_opts(Default::default());
            Self::spawn_with_store(store.into()).await
        }
    }

    /// Mounts the node on an existing store (OPFS on the browser side).
    pub async fn spawn_with_store(store: iroh_blobs::api::Store) -> Result<Self> {
        let address_lookup = MemoryLookup::default();
        let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::N0)
            .address_lookup(address_lookup.clone())
            .bind()
            .await?;
        let downloader = Downloader::new(&store, &endpoint);
        let router = Router::builder(endpoint)
            .accept(iroh_blobs::ALPN, BlobsProtocol::new(&store, None))
            .spawn();
        Ok(Self {
            blobs: store,
            router,
            downloader,
            address_lookup,
        })
    }

    /// Identifier of the local endpoint.
    pub fn endpoint_id(&self) -> EndpointId {
        self.router.endpoint().id()
    }

    /// The underlying iroh endpoint.
    pub fn endpoint(&self) -> &Endpoint {
        self.router.endpoint()
    }

    /// Imports bytes into the store and returns a transfer ticket.
    pub async fn import(&self, data: Bytes) -> Result<BlobTicket> {
        let tag = self
            .blobs
            .add_bytes(data)
            .await
            .inspect_err(|err| tracing::warn!(?err, "import failed"))?;
        tracing::info!(?tag, "imported");
        self.ticket(tag.hash, tag.format).await
    }

    /// Downloads the content of a ticket and waits for completion.
    pub async fn download(&self, ticket: BlobTicket) -> Result<Hash> {
        self.address_lookup.add_endpoint_info(ticket.addr().clone());
        self.downloader
            .download(ticket.hash_and_format(), [ticket.addr().id])
            .await?;
        Ok(ticket.hash())
    }

    /// Status of a blob in the local store.
    pub async fn status(&self, hash: Hash) -> Result<BlobStatus> {
        Ok(self.blobs.status(hash).await?)
    }

    /// Size of the blob once complete.
    pub async fn complete_size(&self, hash: Hash) -> Result<u64> {
        match self.status(hash).await? {
            BlobStatus::NotFound => Err(anyhow!("blob not found")),
            BlobStatus::Partial { .. } => Err(anyhow!("blob is incomplete")),
            BlobStatus::Complete { size } => Ok(size),
        }
    }

    /// Bytes of the blob (spike: text only).
    pub async fn get_bytes(&self, hash: Hash) -> Result<Bytes> {
        Ok(self.blobs.get_bytes(hash).await?)
    }

    /// Builds a transfer ticket for the blob `hash`, waiting for the
    /// endpoint to come online first.
    pub async fn ticket(&self, hash: Hash, format: BlobFormat) -> Result<BlobTicket> {
        self.endpoint().online().await;
        let addr = self.endpoint().addr();
        Ok(BlobTicket::new(addr, hash, format))
    }
}

#[cfg(test)]
mod tests {
    /// Guard rail for the iroh-blobs micro-patch: `api::Store::local` must
    /// stay public and accept a standard local channel (contract of the
    /// `sendblob/local-store-ctor` fork branch).
    #[test]
    fn local_store_constructor_is_public() {
        use iroh_blobs::api::Store;
        let (tx, rx) = tokio::sync::mpsc::channel::<iroh_blobs::api::proto::Command>(1);
        drop(rx);
        let _store = Store::local(tx.into());
    }
}

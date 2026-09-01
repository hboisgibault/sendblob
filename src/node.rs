//! Logique cœur partagée entre le build WASM (navigateur) et le CLI natif.
//!
//! `BlobsNode` monte un endpoint iroh (presets N0 : relays publics + DNS/pkarr),
//! un store iroh-blobs et le routeur du protocole blobs. Modèle inspiré de
//! l'exemple n0-computer/iroh-examples/browser-blobs.

use anyhow::{anyhow, Result};
use bytes::Bytes;
use iroh::{address_lookup::MemoryLookup, protocol::Router, Endpoint, EndpointId};
use iroh_blobs::{
    api::{blobs::BlobStatus, downloader::Downloader, Store},
    ticket::BlobTicket,
    BlobFormat, BlobsProtocol, Hash,
};

/// Identifiant ALPN applicatif sendblob (réservé, non utilisé dans le spike :
/// l'interop browser↔CLI passe par l'ALPN standard iroh-blobs).
pub const ALPN: &[u8] = b"sendblob/blobs/0";

/// Taille maximale visée en V1 (2 GiB) avec le futur store OPFS.
pub const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024 * 1024;

/// Taille des chunks utilisés pour streamer un fichier vers le store (4 MiB).
pub const CHUNK_SIZE: u32 = 4 * 1024 * 1024;

/// États haut niveau d'un noeud sendblob, exposés à l'UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeStatus {
    Idle,
    Connecting,
    Ready,
    Transferring,
    Closed,
}

/// Noeud sendblob : endpoint iroh + store de blobs + routeur protocole.
#[derive(Debug, Clone)]
pub struct BlobsNode {
    address_lookup: MemoryLookup,
    router: Router,
    pub blobs: Store,
    downloader: Downloader,
}

impl BlobsNode {
    pub async fn spawn() -> Result<Self> {
        let address_lookup = MemoryLookup::default();
        let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::N0)
            .address_lookup(address_lookup.clone())
            .bind()
            .await?;
        let store = iroh_blobs::store::mem::MemStore::default();
        let downloader = Downloader::new(&store, &endpoint);
        let router = Router::builder(endpoint)
            .accept(iroh_blobs::ALPN, BlobsProtocol::new(&store, None))
            .spawn();
        Ok(Self {
            blobs: store.as_ref().clone(),
            router,
            downloader,
            address_lookup,
        })
    }

    pub fn endpoint_id(&self) -> EndpointId {
        self.router.endpoint().id()
    }

    pub fn endpoint(&self) -> &Endpoint {
        self.router.endpoint()
    }

    /// Publie des octets dans le store et retourne le ticket de transfert.
    pub async fn import(&self, data: Bytes) -> Result<BlobTicket> {
        let tag = self
            .blobs
            .add_bytes(data)
            .await
            .inspect_err(|err| tracing::warn!(?err, "import failed"))?;
        tracing::info!(?tag, "imported");
        self.ticket(tag.hash, tag.format).await
    }

    /// Télécharge le contenu d'un ticket et attend la complétion.
    pub async fn download(&self, ticket: BlobTicket) -> Result<Hash> {
        self.address_lookup.add_endpoint_info(ticket.addr().clone());
        self.downloader
            .download(ticket.hash_and_format(), [ticket.addr().id])
            .await?;
        Ok(ticket.hash())
    }

    /// Statut d'un blob dans le store local.
    pub async fn status(&self, hash: Hash) -> Result<BlobStatus> {
        Ok(self.blobs.status(hash).await?)
    }

    /// Taille du blob une fois complet.
    pub async fn complete_size(&self, hash: Hash) -> Result<u64> {
        match self.status(hash).await? {
            BlobStatus::NotFound => Err(anyhow!("blob not found")),
            BlobStatus::Partial { .. } => Err(anyhow!("blob is incomplete")),
            BlobStatus::Complete { size } => Ok(size),
        }
    }

    /// Octets du blob (spike : textes uniquement).
    pub async fn get_bytes(&self, hash: Hash) -> Result<Bytes> {
        Ok(self.blobs.get_bytes(hash).await?)
    }

    pub async fn ticket(&self, hash: Hash, format: BlobFormat) -> Result<BlobTicket> {
        self.endpoint().online().await;
        let addr = self.endpoint().addr();
        Ok(BlobTicket::new(addr, hash, format))
    }
}

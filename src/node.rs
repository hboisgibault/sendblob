//! Core logic shared between the WASM build (browser) and the native CLI.
//!
//! [`BlobsNode`] sets up an iroh endpoint (N0 presets: public relays +
//! DNS/pkarr), an iroh-blobs store and the blobs protocol router. Modeled
//! after the n0-computer/iroh-examples/browser-blobs example.

use anyhow::{Result, anyhow};
use bytes::Bytes;
use data_encoding::BASE64URL_NOPAD;
use iroh::{Endpoint, EndpointId, address_lookup::MemoryLookup, protocol::Router};
use iroh_blobs::{
    BlobFormat, BlobsProtocol, Hash, HashAndFormat,
    api::{Store, blobs::BlobStatus, downloader::Downloader},
    ticket::BlobTicket,
};

/// Version byte of the compact ticket payload (see [`encode_compact`]).
const COMPACT_VERSION: u8 = 1;

/// Length of the compact ticket payload:
/// version (1) + node id (32) + hash (32) + format (1).
const COMPACT_LEN: usize = 1 + 32 + 32 + 1;

/// Encodes a ticket in compact form: version (1) + node id (32) + hash (32)
/// + format (1), base64url (88 chars).
///
/// The node id is enough to reach the sender: the N0 DNS discovery (enabled
/// by the endpoint preset) publishes its addresses. Only the explicit direct
/// addresses of the full ticket are dropped — a hint, not a requirement.
pub fn encode_compact(ticket: &BlobTicket) -> String {
    let mut buf = [0u8; COMPACT_LEN];
    buf[0] = COMPACT_VERSION;
    buf[1..33].copy_from_slice(ticket.addr().id.as_bytes());
    buf[33..65].copy_from_slice(ticket.hash().as_bytes());
    buf[65] = match ticket.format() {
        BlobFormat::Raw => 0,
        BlobFormat::HashSeq => 1,
    };
    BASE64URL_NOPAD.encode(&buf)
}

/// Decodes a compact ticket payload produced by [`encode_compact`].
pub fn decode_compact(s: &str) -> Result<(EndpointId, Hash, BlobFormat)> {
    let invalid = || anyhow!("invalid compact ticket");
    let buf = BASE64URL_NOPAD
        .decode(s.as_bytes())
        .map_err(|_| invalid())?;
    if buf.len() != COMPACT_LEN || buf[0] != COMPACT_VERSION {
        return Err(invalid());
    }
    let id = EndpointId::from_bytes(&buf[1..33].try_into().map_err(|_| invalid())?)
        .map_err(|_| invalid())?;
    let hash = Hash::from_bytes(buf[33..65].try_into().map_err(|_| invalid())?);
    let format = match buf[65] {
        0 => BlobFormat::Raw,
        1 => BlobFormat::HashSeq,
        _ => return Err(invalid()),
    };
    Ok((id, hash, format))
}

/// Parses either a full iroh-blobs ticket (`blob…`) or a compact payload
/// (see [`encode_compact`]) into its download parts.
pub fn parse_ticket(s: &str) -> Result<(EndpointId, Hash, BlobFormat)> {
    if let Ok(ticket) = s.parse::<BlobTicket>() {
        return Ok((ticket.addr().id, ticket.hash(), ticket.format()));
    }
    decode_compact(s)
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
    /// Spawns a node with the default in-memory store (native only; the
    /// browser path is [`BlobsNode::spawn_with_store`] with the OPFS store,
    /// see `wasm::BlobsNode::spawn`).
    #[cfg(not(target_arch = "wasm32"))]
    pub async fn spawn() -> Result<Self> {
        let store = iroh_blobs::store::mem::MemStore::default();
        Self::spawn_with_store(store.as_ref().clone()).await
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
        self.download_parts(ticket.addr().id, ticket.hash(), ticket.format())
            .await
    }

    /// Downloads the content identified by `(node id, hash, format)` and
    /// waits for completion. The sender's addresses come from the endpoint's
    /// discovery services (N0 DNS/pkarr).
    pub async fn download_parts(
        &self,
        id: EndpointId,
        hash: Hash,
        format: BlobFormat,
    ) -> Result<Hash> {
        self.downloader
            .download(HashAndFormat { hash, format }, [id])
            .await?;
        Ok(hash)
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
    use super::*;

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

    fn test_ticket() -> BlobTicket {
        let secret = iroh::SecretKey::generate();
        let id = secret.public();
        let hash = Hash::new(b"test payload");
        let relay: iroh::RelayUrl = "https://euc1-1.relay.n0.iroh.link.".parse().unwrap();
        let addr = iroh::EndpointAddr::from_parts(id, [iroh::TransportAddr::Relay(relay)]);
        BlobTicket::new(addr, hash, BlobFormat::Raw)
    }

    #[test]
    fn compact_round_trip() {
        let ticket = test_ticket();
        let (id, hash, format) = decode_compact(&encode_compact(&ticket)).unwrap();
        assert_eq!(id, ticket.addr().id);
        assert_eq!(hash, ticket.hash());
        assert_eq!(format, ticket.format());
        // the compact payload stays fixed at 88 chars while a full ticket
        // grows with relay/direct addresses (~170 chars here, more in practice)
        let full = ticket.to_string();
        let compact = encode_compact(&ticket);
        assert_eq!(compact.len(), 88);
        assert!(full.len() > 160, "{full}");
        assert!(compact.len() < full.len(), "{compact} vs {full}");
    }

    #[test]
    fn parse_ticket_accepts_both_forms() {
        let ticket = test_ticket();
        let (a, b) = (parse_ticket(&ticket.to_string()), {
            let (id, hash, format) = parse_ticket(&encode_compact(&ticket)).unwrap();
            (id, hash, format)
        });
        assert_eq!(a.unwrap(), b);
    }

    #[test]
    fn compact_rejects_garbage() {
        assert!(decode_compact("").is_err());
        assert!(decode_compact("not-base64!").is_err());
        assert!(decode_compact(&"A".repeat(88)).is_err());
        // valid base64url but wrong length and version
        assert!(decode_compact(&BASE64URL_NOPAD.encode(&[0u8; 66])).is_err());
    }
}

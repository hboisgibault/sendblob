//! Bindings WASM exposés au frontend TypeScript.
//!
//! Spike S1 : texte provide/download via le `BlobsNode`. Les gros fichiers
//! passeront par le store OPFS en phase 2.

use anyhow::Result;
use bytes::Bytes;
use iroh_blobs::{ticket::BlobTicket, Hash};
use js_sys::Uint8Array;
use tracing::level_filters::LevelFilter;
use tracing_subscriber_wasm::MakeConsoleWriter;
use wasm_bindgen::{prelude::wasm_bindgen, JsError};

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
    tracing_subscriber::fmt()
        .with_max_level(LevelFilter::INFO)
        .with_writer(
            MakeConsoleWriter::default().map_trace_level_to(tracing::Level::DEBUG),
        )
        .without_time()
        .with_ansi(false)
        .init();
}

/// Version du crate, pratique pour vérifier l'appariement WASM/UI.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Noeud sendblob côté navigateur.
#[wasm_bindgen]
pub struct BlobsNode(crate::node::BlobsNode);

#[wasm_bindgen]
impl BlobsNode {
    pub async fn spawn() -> Result<Self, JsError> {
        Ok(Self(crate::node::BlobsNode::spawn().await.map_err(to_js_err)?))
    }

    pub fn endpoint_id(&self) -> String {
        self.0.endpoint_id().to_string()
    }

    /// Publie des octets, retourne le ticket.
    pub async fn import(&self, data: Uint8Array) -> Result<String, JsError> {
        let data = uint8array_to_bytes(&data);
        tracing::info!("importing data of len {}", data.len());
        let ticket = self.0.import(data).await.map_err(to_js_err)?;
        Ok(ticket.to_string())
    }

    /// Télécharge depuis un ticket, retourne le hash à complétion.
    pub async fn download(&self, ticket: String) -> Result<String, JsError> {
        let ticket: BlobTicket = ticket.parse().map_err(to_js_err)?;
        let hash = self.0.download(ticket).await.map_err(to_js_err)?;
        Ok(hash.to_string())
    }

    /// Hash extrait d'un ticket, sans lancer de téléchargement (pour la progression).
    pub fn hash_from_ticket(&self, ticket: String) -> Result<String, JsError> {
        let ticket: BlobTicket = ticket.parse().map_err(to_js_err)?;
        Ok(ticket.hash().to_string())
    }

    /// Statut du blob : "not_found", "partial:<octets reçus>", "complete:<taille>".
    pub async fn status(&self, hash: String) -> Result<String, JsError> {
        let hash: Hash = hash.parse().map_err(to_js_err)?;
        let status = self.0.status(hash).await.map_err(to_js_err)?;
        Ok(match status {
            iroh_blobs::api::blobs::BlobStatus::NotFound => "not_found".to_string(),
            iroh_blobs::api::blobs::BlobStatus::Partial { size } => {
                format!("partial:{}", size.unwrap_or(0))
            }
            iroh_blobs::api::blobs::BlobStatus::Complete { size } => format!("complete:{size}"),
        })
    }

    /// Octets du blob téléchargé.
    pub async fn get(&self, hash: String) -> Result<Uint8Array, JsError> {
        let hash: Hash = hash.parse().map_err(to_js_err)?;
        let bytes = self.0.get_bytes(hash).await.map_err(to_js_err)?;
        Ok(bytes_to_uint8array(&bytes))
    }
}

fn to_js_err(err: impl Into<anyhow::Error>) -> JsError {
    let err: anyhow::Error = err.into();
    JsError::new(&err.to_string())
}

pub fn uint8array_to_bytes(data: &Uint8Array) -> Bytes {
    let mut buffer = vec![0u8; data.length() as usize];
    data.copy_to(&mut buffer[..]);
    Bytes::from(buffer)
}

pub fn bytes_to_uint8array(bytes: &[u8]) -> Uint8Array {
    let array = Uint8Array::new_with_length(bytes.len() as u32);
    array.copy_from(bytes);
    array
}

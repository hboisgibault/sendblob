//! sendblob — instant, browser-to-browser P2P file transfers powered by Iroh.
//!
//! This crate is the core layer of sendblob: it sets up an iroh endpoint with
//! a blob store and exposes the transfer operations, both in the browser
//! (compiled to WebAssembly) and natively (companion CLI).
//!
//! # Architecture
//!
//! - [`node`] sets up an iroh endpoint (N0 presets: public relays + DNS/pkarr),
//!   an iroh-blobs store and the blobs protocol router. See [`node::BlobsNode`].
//! - [`store`] implements a custom local store whose data and outboards live
//!   in files ([`crate::file`]), backed by OPFS in the browser.
//! - [`file`] defines the file storage abstraction of the store: OPFS (wasm)
//!   or in-memory files (native tests).
//! - [`wasm`] (wasm32 only) exposes the `wasm-bindgen` bindings consumed by
//!   the TypeScript frontend.
//!
//! # Interoperability
//!
//! Transfers go through the standard iroh-blobs ALPN: a browser sendblob node
//! interoperates with the CLI and with any iroh-blobs peer.
#![warn(missing_docs)]

pub mod file;
pub mod node;
pub mod store;

#[cfg(target_arch = "wasm32")]
pub mod wasm;

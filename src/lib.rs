//! sendblob — instant, browser-to-browser P2P file transfers powered by Iroh.

pub mod node;

#[cfg(target_arch = "wasm32")]
pub mod wasm;

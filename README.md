# ⚡ sendblob

> Instant, browser-to-browser P2P file transfers powered by **Iroh** and **WebAssembly**. No clouds, no middleman, no registration.

**sendblob** turns your browser tab into a temporary, high-performance P2P storage node. Drop a file, share the generated QR code or link, and stream the data directly to the recipient using the QUIC-powered Iroh protocol. Once you close the tab, your node stops and all traces vanish.

### ✨ Key Features

- 🔒 **True Zero-Server P2P:** Files travel directly from browser to browser.
- ⚡ **Powered by Iroh & WASM:** Leverages `iroh-blobs` compiled to WebAssembly for ultra-fast BLAKE3-hashed transfers.
- 📲 **QR Code Instant Pairing:** Share transfers effortlessly between desktop and mobile devices.
- 🧹 **Ephemeral by Design:** No persistent cloud storage. Closing the browser tab terminates the node immediately.
- 🛡️ **End-to-End Encrypted & Secure:** Built on QUIC and NAT-traversal primitives out of the box.

### 🛠️ Tech Stack

- **Engine:** Rust, `iroh-blobs`, `wasm-bindgen` (via `browser-blobs`)
- **Frontend:** HTML5 / Tailwind CSS / TypeScript
- **Transport:** QUIC / WebTransport via Iroh Network

---

*Inspired by the `browser-blobs` example from the [n0-computer/iroh](https://github.com/n0-computer/iroh) team.*

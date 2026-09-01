# ⚡ sendblob

> Instant, browser-to-browser P2P file transfers powered by **Iroh** and **WebAssembly**. No clouds, no middleman, no registration.

**sendblob** turns your browser tab into a temporary, high-performance P2P storage node. Drop a file, share the generated ticket or link, and stream the data directly to the recipient using the QUIC-powered Iroh protocol. Once you close the tab, your node stops and all traces vanish.

### ✨ Key Features

- 🔒 **True Zero-Server P2P:** Files travel directly from browser to browser.
- ⚡ **Powered by Iroh & WASM:** Leverages `iroh-blobs` compiled to WebAssembly for ultra-fast BLAKE3-hashed transfers.
- 🛡️ **End-to-End Encrypted & Secure:** Built on QUIC and NAT-traversal primitives out of the box.
- 🧹 **Ephemeral by Design:** No persistent cloud storage. Closing the browser tab terminates the node immediately.

### 🛠️ Tech Stack

- **Engine:** Rust, `iroh-blobs`, `wasm-bindgen` (via `browser-blobs`)
- **Frontend:** HTML5 / Tailwind CSS / TypeScript
- **Transport:** QUIC / WebTransport via Iroh Network

### 🏗️ Architecture

```
┌─────────────  web/  ─────────────┐   ┌─── src/ (Rust) ────┐
│ main.tsx     UI (Solid)          │   │ node.rs   iroh endpoint + │
│ state.ts     signals + actions   │   │           blobs protocol   │
│ transfer.ts  send/receive pipeline│  │ wasm.rs   wasm-bindgen API │
│ protocol.ts  typed worker RPC    │◄─►│ store.rs  OPFS blob store  │
│ worker.ts    worker + OPFS purge │   │ file.rs   OPFS/mem files   │
└──────────────────────────────────┘   └────────────────────────────┘
```

- **`node.rs`** — sets up the iroh endpoint (N0 presets: public relays +
  DNS/pkarr discovery), the blob store and the protocol router. Transfers go
  through the standard iroh-blobs ALPN, so a browser node interoperates with
  the CLI and any iroh-blobs peer.
- **`store.rs`** — custom local store (irpc actor, same architecture as
  upstream `MemStore`): data and outboards live in files instead of RAM,
  with sparse validated writes for downloads and an injectable quota check.
- **`file.rs`** — the file abstraction behind the store: OPFS sync access
  handles in the browser, in-memory files for native tests.
- **`wasm.rs`** — the `wasm-bindgen` surface consumed by the TypeScript
  frontend (import/download/status/observe).
- **`web/`** — the frontend: a Solid UI (`main.tsx`, single screen with
  auto-start, QR share and native mobile share) on top of a reusable
  pipeline (`transfer.ts`) talking to the WASM node through a typed,
  event-aware worker RPC (`protocol.ts`).

The browser node is ephemeral by design: each tab owns its OPFS
subdirectory, a Web Locks-based purge reclaims the storage of dead tabs,
and closing the tab stops the node.

---

*Inspired by the `browser-blobs` example from the [n0-computer/iroh](https://github.com/n0-computer/iroh) team.*

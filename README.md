# sendblob

Share a file from your browser using iroh-blobs: [sendblob.app](https://sendblob.app). Drop a file, share the ticket or link, and the recipient downloads it — from another browser tab or from any iroh-blobs node (e.g. the companion CLI).

## How it works

- Each tab runs an ephemeral iroh node (WASM + OPFS store) speaking the
  standard iroh-blobs protocol.
- Sharing = importing bytes into the local store + handing out a ticket
  (`blob…` or the 88-char compact form embedded in the link).
- Receiving = resolving the ticket, downloading and validating chunks
  into OPFS, then saving to disk.

Works with any iroh node: browser tabs interoperate with the native CLI
(`provide` / `download`) and other iroh-blobs peers over the same ALPN.

## Network reality

- This is not direct browser-to-browser P2P today. Browsers cannot open
  direct QUIC/TCP connections, so traffic is relayed through public iroh
  relays, with discovery to find the sender.
- Relayed traffic stays end-to-end encrypted by iroh: relays forward
  bytes but cannot read file contents. They do see metadata (endpoints,
  volumes) and are a hard dependency — no relay, no transfer.
- Direct browser connectivity should come via WebTransport support in
  iroh. Until then, expect relay bandwidth/latency and relay availability
  to bound performance.

## Ephemeral by design

Closing the tab stops the node. Files live in a per-tab OPFS directory,
reclaimed by a Web Locks-based purge; nothing is uploaded to persistent
cloud storage by sendblob itself.

## Development

Prerequisites: Rust with the `wasm32-unknown-unknown` target,
`wasm-bindgen-cli` 0.2.127 (must match the crate version), Node.js 24.

- `npm run dev` — build the WASM module and start the Vite dev server
- `npm run build` — production build (WASM + frontend)
- `npm run typecheck` — TypeScript check
- `cargo test --all-features` — Rust tests

---

*Inspired by the `browser-blobs` example from the [n0-computer/iroh](https://github.com/n0-computer/iroh) team.*

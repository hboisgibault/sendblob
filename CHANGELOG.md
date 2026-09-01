# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Share links carry the original file name (`#t=…&n=…`, out-of-band in the
  URL fragment): receivers save the download under the sender's name
  (sanitized, max 120 chars) instead of `sendblob-<hash>.bin`. Pasted or
  legacy links without `n` keep the hash-based fallback.

### Fixed

- Receive: the store-side progress subscription (`observe`) is now cancelled
  through `unobserve` when the transfer fails or after completion; a failed
  download used to leak the subscription until the blob completed.
- Store: a rejected quota check no longer leaves an empty entry and orphan
  files behind — the check now runs before anything is created.
- Store: `import_bao` propagates IO failures to the caller through the
  result channel instead of dropping it silently.
- Store: OPFS sync access handles are now released (`close()`) when entries
  are removed, when duplicate imports are discarded, and at actor shutdown.
- Worker bridge: `WorkerRpc` rejects every pending call when the worker
  errors out (`onerror`), instead of hanging forever.

### Changed

- Upload progress is tracked on the JS side (bytes pushed to `import_chunk`);
  the `import_progress` RPC and its Rust-side duplicate counter are removed.
- Download progress is pushed by the store (`observe` bitfield stream) to the
  UI through worker events; polling every 150 ms is gone.
- `status` returns a structured `{ state, bytesDone, size }` object instead
  of the `"partial:<n>"` string protocol; `blob_size` is folded into it.
- Tracing setup is exposed as `init_tracing(level)` (idempotent); the
  automatic `start` hook uses `info`.
- `BlobsNode::spawn` is native-only; the browser path is `spawn_with_store`
  with the OPFS store.
- Store: `Options::dir` is now mandatory (`Arc<dyn BlobDir>`, in-memory dir
  for native tests, OPFS dir in the browser); the wasm-only `NullDir` /
  `default_dir` compile fallback is gone.
- DRY: shared `js_object` helper replaces the three duplicated JS object
  builders in the wasm bindings; shared file-cleanup helper (`remove_files`)
  in the store actor; new `read_some_at` file helper reused by
  `read_exact_at` and the store's stream reader; `state.ts` reuses
  `clearTicketFromUrl` instead of inlining the fragment cleanup.
- Dead code removed: `NodeStatus`, `ALPN`, `MAX_FILE_SIZE`, `CHUNK_SIZE`,
  `PendingImport.name`; phase-1 spike bindings `BlobsNode::import`
  (single-shot bytes) and `BlobsNode::get` (text) with their worker RPC
  kinds, and the `BlobsNode::endpoint` accessor (internal use only).
- CI: `cargo fmt --check` runs on every build; the wasm build environment
  (toolchain + pinned `wasm-bindgen-cli`) is factored into a shared action.

## [0.1.0]

### Added

- Custom OPFS-backed local store for the browser: streamed uploads, sparse
  validated downloads (bao), observable bitfields, minimal tags API.
- iroh endpoint + blobs protocol node shared between WASM (browser) and a
  native CLI (`provide` / `download`).
- WASM bindings for the TypeScript frontend: import (bytes / stream),
  download, save through OPFS file handles (zero heap copy), storage quota.
- Web UI: file transfer, text transfer, QR scaffolding, OPFS bench.
- Compact ticket encoding (88-char base64url payloads) alongside the full
  iroh-blobs tickets.
- E2E browser tests (Playwright): multi-tab transfer, receive reproduction.

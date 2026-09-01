/**
 * File send/receive pipeline.
 *
 * Send: `File.slice` (4 MiB) → worker → wasm → OPFS, outboard computed at
 * the end. Receive: sparse validated writes into OPFS, then zero-copy save
 * through the `File` backed by the OPFS file.
 */

import type { BlobStatus, WorkerRpcLike } from "./protocol";

export interface TransferProgress {
  bytesDone: number;
  bytesTotal: number;
}

/** Size of the chunks streamed to the worker (4 MiB, cf. Rust CHUNK_SIZE). */
const CHUNK_SIZE = 4 * 1024 * 1024;

export async function sendFile(
  rpc: WorkerRpcLike,
  file: File,
  onProgress?: (p: TransferProgress) => void,
): Promise<string> {
  const id = await rpc.call<number>({ kind: "import_begin", size: file.size });
  try {
    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const buffer = await file.slice(offset, end).arrayBuffer();
      await rpc.call({ kind: "import_chunk", importId: id, data: new Uint8Array(buffer) }, [
        buffer,
      ]);
      onProgress?.({ bytesDone: end, bytesTotal: file.size });
    }
    const ticket = await rpc.call<string>({ kind: "import_finish", importId: id });
    onProgress?.({ bytesDone: file.size, bytesTotal: file.size });
    return ticket;
  } catch (err) {
    await rpc.call({ kind: "import_abort", importId: id }).catch(() => {});
    throw err;
  }
}

export interface ReceivedFile {
  hash: string;
  size: number;
  /** Triggers saving to disk (blob backed by OPFS, zero copy). */
  save: (filename: string) => Promise<void>;
}

export interface ReceiveOptions {
  /** Total download attempts (first try + retries). */
  maxAttempts?: number;
  /** Notified before each retry (1 = first retry). */
  onRetry?: (attempt: number, err: unknown) => void;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function receiveFile(
  rpc: WorkerRpcLike,
  ticket: string,
  onProgress?: (p: TransferProgress) => void,
  opts?: ReceiveOptions,
): Promise<ReceivedFile> {
  const maxAttempts = Math.max(1, opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const hash = await rpc.call<string>({ kind: "hash_from_ticket", ticket });

  // progress pushed by the store (bitfield updates, cf. Rust `observe`)
  const unsubscribe = onProgress
    ? rpc.on((ev) => {
        if (ev.hash !== hash) return;
        onProgress({
          bytesDone: ev.bytesDone,
          // display without a total until the first byte arrives
          bytesTotal: ev.bytesTotal ?? Math.max(ev.bytesDone, 1),
        });
      })
    : null;
  let observeId: number | null = null;
  try {
    observeId = await rpc.call<number>({ kind: "observe", hash });
    // Each attempt resumes from the store bitfield: validated chunks are
    // kept in OPFS and only the missing ones are re-requested, so the
    // progress events stay continuous across attempts.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rpc.call({ kind: "download", ticket });
        break;
      } catch (err) {
        if (attempt >= maxAttempts) throw err;
        opts?.onRetry?.(attempt, err);
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  } finally {
    unsubscribe?.();
    // cancels the store-side subscription too (no-op once it self-terminated
    // on completion); without this, a failed download leaks the subscription
    if (observeId !== null) {
      await rpc.call({ kind: "unobserve", id: observeId }).catch(() => {});
    }
  }

  const status = await rpc.call<BlobStatus>({ kind: "status", hash });
  const size = status.size ?? 0;
  onProgress?.({ bytesDone: size, bytesTotal: size });

  return {
    hash,
    size,
    async save(filename: string) {
      const handle = await rpc.call<FileSystemFileHandle>({ kind: "save", hash });
      const file = await handle.getFile();
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || `sendblob-${hash.slice(0, 8)}.bin`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // the blob stays backed by OPFS: no heap copy to revoke urgently
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  };
}


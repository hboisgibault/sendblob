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

export async function receiveFile(
  rpc: WorkerRpcLike,
  ticket: string,
  onProgress?: (p: TransferProgress) => void,
): Promise<ReceivedFile> {
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
  try {
    await rpc.call<number>({ kind: "observe", hash });
    await rpc.call({ kind: "download", ticket });
  } catch (err) {
    unsubscribe?.();
    throw err;
  }
  unsubscribe?.();

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


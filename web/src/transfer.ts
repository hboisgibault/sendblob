/**
 * File send/receive pipeline.
 *
 * Send: `File.slice` (4 MiB) → worker → wasm → OPFS, outboard computed at
 * the end. Receive: sparse validated writes into OPFS, then zero-copy save
 * through the `File` backed by the OPFS file.
 */

export interface TransferProgress {
  bytesDone: number;
  bytesTotal: number;
}

/** Size of the chunks streamed to the worker (4 MiB, cf. Rust CHUNK_SIZE). */
const CHUNK_SIZE = 4 * 1024 * 1024;

export async function sendFile(
  rpc: { call<T>(msg: unknown, transfer?: Transferable[]): Promise<T> },
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
  rpc: { call<T>(msg: unknown, transfer?: Transferable[]): Promise<T> },
  ticket: string,
  onProgress?: (p: TransferProgress) => void,
): Promise<ReceivedFile> {
  const hash = await rpc.call<string>({ kind: "hash_from_ticket", ticket });

  // progress via status (bitfield → validated bytes)
  const stopPolling = pollStatus(rpc, hash, onProgress);
  try {
    await rpc.call({ kind: "download", ticket });
  } catch (err) {
    stopPolling();
    throw err;
  }
  stopPolling();

  const size = await rpc.call<number>({ kind: "blob_size", hash });
  onProgress?.({ bytesDone: size, bytesTotal: size });

  return {
    hash,
    size,
    async save(filename: string) {
      const handle = (await rpc.call<FileSystemFileHandle>({
        kind: "save",
        hash,
      })) as FileSystemFileHandle & {
        getFile(): Promise<File>;
      };
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

function pollStatus(
  rpc: { call<T>(msg: unknown, transfer?: Transferable[]): Promise<T> },
  hash: string,
  onProgress?: (p: TransferProgress) => void,
): () => void {
  if (!onProgress) return () => {};
  let total = 0;
  let finished = false;
  const timer = setInterval(async () => {
    if (finished) return;
    try {
      const status = await rpc.call<string>({ kind: "status", hash });
      const [kind, value] = status.split(":");
      if (kind === "complete") {
        total = Number(value);
        onProgress({ bytesDone: total, bytesTotal: total });
      } else if (kind === "partial") {
        const done = Number(value);
        // the total size is only known once the first byte arrives; display
        // without a total until we have it (bytesTotal = done)
        if (total > 0) onProgress({ bytesDone: done, bytesTotal: total });
        else onProgress({ bytesDone: done, bytesTotal: Math.max(done, 1) });
      }
    } catch {
      /* next tick */
    }
  }, 150);
  return () => clearInterval(timer);
}

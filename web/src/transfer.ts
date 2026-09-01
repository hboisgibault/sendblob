/**
 * Pipeline d'envoi/réception de fichiers.
 *
 * Envoi : `File.slice` (4 MiB) → worker → wasm → OPFS, outboard calculé
 * à la fin. Réception : écritures sparses validées dans l'OPFS, puis
 * sauvegarde zéro-copie via le `File` adossé au fichier OPFS.
 */

export interface TransferProgress {
  bytesDone: number;
  bytesTotal: number;
}

/** Taille des chunks streamés vers le worker (4 MiB, cf. CHUNK_SIZE Rust). */
const CHUNK_SIZE = 4 * 1024 * 1024;

/** Intervalle de polling de progression (ms). */
const PROGRESS_INTERVAL = 150;

export async function sendFile(
  rpc: { call<T>(msg: unknown, transfer?: Transferable[]): Promise<T> },
  file: File,
  onProgress?: (p: TransferProgress) => void,
): Promise<string> {
  const id = await rpc.call<number>({
    kind: "import_begin",
    name: file.name,
    size: file.size,
  });

  const stopPolling = pollProgress(rpc, id, file.size, onProgress);
  try {
    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const buffer = await file.slice(offset, end).arrayBuffer();
      await rpc.call({ kind: "import_chunk", importId: id, data: new Uint8Array(buffer) }, [
        buffer,
      ]);
    }
    const ticket = await rpc.call<string>({ kind: "import_finish", importId: id });
    stopPolling();
    onProgress?.({ bytesDone: file.size, bytesTotal: file.size });
    return ticket;
  } catch (err) {
    stopPolling();
    await rpc.call({ kind: "import_abort", importId: id }).catch(() => {});
    throw err;
  }
}

export interface ReceivedFile {
  hash: string;
  size: number;
  /** Déclenche l'enregistrement disque (blob adossé à l'OPFS, zéro copie). */
  save: (filename: string) => Promise<void>;
}

export async function receiveFile(
  rpc: { call<T>(msg: unknown, transfer?: Transferable[]): Promise<T> },
  ticket: string,
  onProgress?: (p: TransferProgress) => void,
): Promise<ReceivedFile> {
  const hash = await rpc.call<string>({ kind: "hash_from_ticket", ticket });

  // progression via statut (bitfield → octets validés)
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
      // le blob reste adossé à l'OPFS : pas de copie heap à révoquer en urgence
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  };
}

function pollProgress(
  rpc: { call<T>(msg: unknown, transfer?: Transferable[]): Promise<T> },
  id: number,
  total: number,
  onProgress?: (p: TransferProgress) => void,
): () => void {
  if (!onProgress) return () => {};
  let finished = false;
  const timer = setInterval(async () => {
    if (finished) return;
    try {
      const done = await rpc.call<number>({ kind: "import_progress", importId: id });
      if (!finished) onProgress({ bytesDone: done, bytesTotal: total });
    } catch {
      /* l'import peut se terminer entre deux ticks */
    }
  }, PROGRESS_INTERVAL);
  return () => {
    finished = true;
    clearInterval(timer);
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
        // la taille totale n'est connue qu'au premier octet reçu ; on
        // l'affiche sans total tant qu'on ne l'a pas (bytesTotal = done)
        if (total > 0) onProgress({ bytesDone: done, bytesTotal: total });
        else onProgress({ bytesDone: done, bytesTotal: Math.max(done, 1) });
      }
    } catch {
      /* tick suivant */
    }
  }, PROGRESS_INTERVAL);
  return () => clearInterval(timer);
}

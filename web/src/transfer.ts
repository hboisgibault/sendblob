/**
 * Pipeline d'envoi/réception de fichiers.
 * Implémentation réelle en phase 2-3 (chunks `File.slice` → wasm, fetch → save).
 */

export interface TransferProgress {
  bytesDone: number;
  bytesTotal: number;
}

export async function sendFile(
  _file: File,
  _onProgress?: (p: TransferProgress) => void,
): Promise<string> {
  throw new Error("not implemented (phase 2-3)");
}

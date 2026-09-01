/// <reference lib="webworker" />
import init, { BlobsNode } from "./wasm/sendblob.js";
import type { ToWorker } from "./protocol";

let node: BlobsNode | null = null;

interface BenchResult {
  writeMbs: number;
  readMbs: number;
  writeMs: number;
  readMs: number;
}

/** Purge du répertoire OPFS `sendblob` : le nœud est éphémère par design.
 *
 * Les fichiers encore verrouillés par un autre onglet (handles ouverts)
 * sont ignorés : ils partiront à la prochaine purge sans verrou.
 */
async function purgeOpfs(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle("sendblob", { create: true });
  // keys() est un itérateur async, absent des types lib.dom selon les versions.
  const keys = (dir as unknown as { keys(): AsyncIterable<string> }).keys();
  const names: string[] = [];
  for await (const name of keys) names.push(name);
  await Promise.allSettled(
    names.map((name) =>
      dir.removeEntry(name).catch(() => {
        /* fichier verrouillé par un autre onglet : tant pis */
      }),
    ),
  );
}

/** S2 : bench throughput OPFS SyncAccessHandle (écriture + lecture séquentielles). */
async function benchOpfs(sizeMb: number, chunkMb: number): Promise<BenchResult> {
  const root = await navigator.storage.getDirectory();
  const name = `sendblob-bench-${Date.now()}`;
  const fh = await root.getFileHandle(name, { create: true });
  const access = await fh.createSyncAccessHandle();
  try {
    const chunk = new Uint8Array(chunkMb * 1024 * 1024);
    for (let i = 0; i < chunk.length; i += 65536) {
      crypto.getRandomValues(chunk.subarray(i, Math.min(i + 65536, chunk.length)));
    }
    const total = sizeMb * 1024 * 1024;

    let offset = 0;
    const t0 = performance.now();
    while (offset < total) {
      access.write(chunk, { at: offset });
      offset += chunk.length;
    }
    access.flush();
    const writeMs = performance.now() - t0;

    const buf = new Uint8Array(chunk.length);
    let read = 0;
    const t1 = performance.now();
    while (read < total) {
      const n = Math.min(buf.length, total - read);
      access.read(buf.subarray(0, n), { at: read });
      read += n;
    }
    const readMs = performance.now() - t1;

    return {
      writeMbs: sizeMb / (writeMs / 1000),
      readMbs: sizeMb / (readMs / 1000),
      writeMs,
      readMs,
    };
  } finally {
    access.close();
    await root.removeEntry(name);
  }
}

async function handle(msg: ToWorker): Promise<unknown> {
  switch (msg.kind) {
    case "spawn": {
      await init();
      await purgeOpfs();
      node = await BlobsNode.spawn();
      return null;
    }
    case "endpoint_id":
      return node!.endpoint_id();
    case "import":
      return node!.import(msg.data);
    case "import_begin":
      return node!.import_begin(msg.name, msg.size);
    case "import_chunk":
      return node!.import_chunk(msg.importId, msg.data);
    case "import_finish":
      return node!.import_finish(msg.importId);
    case "import_abort":
      return node!.import_abort(msg.importId);
    case "import_progress":
      return node!.import_progress(msg.importId);
    case "download":
      return node!.download(msg.ticket);
    case "hash_from_ticket":
      return node!.hash_from_ticket(msg.ticket);
    case "status":
      return node!.status(msg.hash);
    case "save":
      return node!.save_file(msg.hash);
    case "get":
      return node!.get(msg.hash);
    case "bench_opfs":
      return benchOpfs(msg.sizeMb, msg.chunkMb);
  }
}

self.onmessage = async (ev: MessageEvent<ToWorker & { id: number }>) => {
  const { id } = ev.data;
  try {
    const result = await handle(ev.data);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};

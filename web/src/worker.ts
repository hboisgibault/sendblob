/// <reference lib="webworker" />
import init, { BlobsNode } from "./wasm/sendblob.js";
import type { ToWorker } from "./protocol";

let node: BlobsNode | null = null;

/** Root subdirectory of sendblob data in OPFS. */
const ROOT_DIR = "sendblob";

/** OPFS directory id of this tab (one node per tab: OPFS handles are
 * exclusive, two tabs sharing one directory would block each other). */
let tabId = "";

/** Minimal typing: `navigator.locks` is missing from some lib versions. */
interface LockManagerLike {
  request<R>(
    name: string,
    opts: { ifAvailable: true },
    callback: (lock: unknown | null) => Promise<R>,
  ): Promise<R>;
}

const webLocks = (): LockManagerLike | undefined =>
  (navigator as unknown as { locks?: LockManagerLike }).locks;

/** Liveness lock: held as long as the worker lives, released by the browser
 * when the tab closes or crashes. It is the signal used by the purge to
 * tell live directories apart from orphans. */
function holdLivenessLock(id: string): void {
  webLocks()
    ?.request(`${ROOT_DIR}:alive:${id}`, { ifAvailable: true }, () => new Promise(() => {}))
    .catch(() => {
      /* lock lost (browser shutdown): nothing to do */
    });
}

/** Handle of the sendblob root directory in OPFS. */
async function rootDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ROOT_DIR, { create: true });
}

/** Purge of the `sendblob` OPFS directory: the node is ephemeral by design.
 *
 * Removes free files at the root (legacy flat layout) and directories whose
 * owner tab is dead (liveness lock released). Directories of live tabs are
 * kept. Without Web Locks (older browsers), only free files go away.
 */
async function purgeOpfs(): Promise<void> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await rootDir();
  } catch {
    return; // no directory yet: nothing to purge
  }
  const locks = webLocks();
  const names: string[] = [];
  // keys() is an async iterator, missing from lib.dom types in some versions.
  const keys = (dir as unknown as { keys(): AsyncIterable<string> }).keys();
  for await (const name of keys) names.push(name);
  await Promise.all(
    names.map(async (name) => {
      // legacy file (flat layout from before the per-tab directories)
      if (await isFile(dir, name)) {
        await dir.removeEntry(name).catch(() => {
          /* locked by a tab of a previous version: skipped */
        });
        return;
      }
      // directory: purged only if the owning tab is dead
      if (!locks) return;
      await locks
        .request(`${ROOT_DIR}:alive:${name}`, { ifAvailable: true }, async (lock) => {
          if (lock === null) return; // held: tab is alive
          await dir.removeEntry(name, { recursive: true }).catch(() => {});
        })
        .catch(() => {
          /* raced with the tab closing: next purge */
        });
    }),
  );
}

/** True if `name` designates a file (not a subdirectory). */
async function isFile(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

interface BenchResult {
  writeMbs: number;
  readMbs: number;
  writeMs: number;
  readMs: number;
}

/** S2: bench OPFS SyncAccessHandle throughput (sequential write + read). */
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
      tabId = crypto.randomUUID();
      holdLivenessLock(tabId);
      await purgeOpfs();
      node = await BlobsNode.spawn(tabId);
      return null;
    }
    case "endpoint_id":
      return node!.endpoint_id();
    case "import":
      return node!.import(msg.data);
    case "import_begin":
      return node!.import_begin(msg.size);
    case "import_chunk":
      return node!.import_chunk(msg.importId, msg.data);
    case "import_finish":
      return node!.import_finish(msg.importId);
    case "import_abort":
      return node!.import_abort(msg.importId);
    case "download":
      return node!.download(msg.ticket);
    case "short_ticket":
      return node!.short_ticket(msg.ticket);
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

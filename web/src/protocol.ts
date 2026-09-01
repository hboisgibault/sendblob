/** Shared types + typed main ↔ worker RPC (postMessage). */

export type ToWorker =
  | { kind: "spawn" }
  | { kind: "endpoint_id" }
  | { kind: "import"; data: Uint8Array }
  | { kind: "import_begin"; name: string; size: number }
  | { kind: "import_chunk"; importId: number; data: Uint8Array }
  | { kind: "import_finish"; importId: number }
  | { kind: "import_abort"; importId: number }
  | { kind: "import_progress"; importId: number }
  | { kind: "download"; ticket: string }
  | { kind: "hash_from_ticket"; ticket: string }
  | { kind: "status"; hash: string }
  | { kind: "save"; hash: string }
  | { kind: "get"; hash: string }
  | { kind: "bench_opfs"; sizeMb: number; chunkMb: number };

export type FromWorker =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export type WorkerMsg = ToWorker & { id: number };

export class WorkerRpc {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    };
  }

  /** RPC call; `transfer` lists the buffers to transfer zero-copy. */
  call<T>(msg: ToWorker, transfer?: Transferable[]): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...msg, id } satisfies WorkerMsg, transfer ?? []);
    });
  }
}

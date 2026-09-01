/** Shared types + typed main ↔ worker RPC (postMessage). */

export type ToWorker =
  | { kind: "spawn" }
  | { kind: "endpoint_id" }
  | { kind: "storage_estimate" }
  | { kind: "import"; data: Uint8Array }
  | { kind: "import_begin"; size: number }
  | { kind: "import_chunk"; importId: number; data: Uint8Array }
  | { kind: "import_finish"; importId: number }
  | { kind: "import_abort"; importId: number }
  | { kind: "download"; ticket: string }
  | { kind: "short_ticket"; ticket: string }
  | { kind: "hash_from_ticket"; ticket: string }
  | { kind: "status"; hash: string }
  | { kind: "observe"; hash: string }
  | { kind: "unobserve"; id: number }
  | { kind: "save"; hash: string }
  | { kind: "get"; hash: string };

/** Snapshot of a blob in the local store (Rust `BlobsNode.status`). */
export interface BlobStatus {
  state: "not_found" | "partial" | "complete";
  /** Validated bytes in the local store. */
  bytesDone: number;
  /** Total size, known only when complete. */
  size: number | null;
}

/** Bitfield update pushed by an `observe` subscription. */
export interface ProgressUpdate {
  hash: string;
  bytesDone: number;
  /** Total size, null until the first byte arrives. */
  bytesTotal: number | null;
  complete: boolean;
}

/** Message pushed by the worker outside the request/response flow. */
export type WorkerEvent = ProgressUpdate;

export interface StorageEstimate {
  usage: number;
  quota: number;
}

export type FromWorker =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export type WorkerMsg = ToWorker & { id: number };

/** What the transfer pipeline needs from the worker connection. */
export interface WorkerRpcLike {
  call<T>(msg: ToWorker, transfer?: Transferable[]): Promise<T>;
  /** Subscribes to worker events; returns the unsubscribe function. */
  on(handler: (ev: WorkerEvent) => void): () => void;
}

export class WorkerRpc {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private handlers = new Set<(ev: WorkerEvent) => void>();

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (ev: MessageEvent<FromWorker | WorkerEvent>) => {
      const msg = ev.data;
      if (!("ok" in msg)) {
        const event = msg as WorkerEvent;
        for (const handler of this.handlers) handler(event);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    };
    this.worker.onerror = (ev) => {
      const error = new Error(`worker error: ${ev.message || "(crashed)"}`);
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
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

  /** Subscribes to worker events; returns the unsubscribe function. */
  on(handler: (ev: WorkerEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

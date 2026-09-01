/**
 * App state as Solid signals + the actions that mutate it.
 *
 * The node spawns automatically (no start button). The URL fragment is
 * consumed at boot: a `#t=…` link switches the app to the incoming view
 * and downloads as soon as the node is ready.
 */

import { batch, createSignal } from "solid-js";
import { WorkerRpc, type StorageEstimate } from "./protocol";
import { receiveFile, sendFile, DEFAULT_MAX_ATTEMPTS } from "./transfer";
import { clearTicketFromUrl, encodeLink, parseTicketFromUrl, type ShareLink } from "./ticket";

export const rpc = new WorkerRpc();

// ==== formatting =============================================================

export const fmtBytes = (n: number) => {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${n} B`;
};

export const fmtSpeed = (mibps: number | null) =>
  mibps === null ? "" : `${mibps.toFixed(1)} MiB/s`;

// ==== signals ================================================================

export type NodeStatus = "connecting" | "ready" | "error";
export type SendState = "idle" | "importing" | "ready" | "error";

const [nodeStatus, setNodeStatus] = createSignal<NodeStatus>("connecting");
const [nodeError, setNodeError] = createSignal("");
const [sendState, setSendState] = createSignal<SendState>("idle");
const [sendError, setSendError] = createSignal("");
const [fileMeta, setFileMeta] = createSignal<{ name: string; size: number } | null>(null);
const [sendProgress, setSendProgress] = createSignal({ done: 0, total: 0 });
const [ticket, setTicket] = createSignal<string | null>(null);
const [link, setLink] = createSignal("");
const [copied, setCopied] = createSignal(false);

const pendingUrlShare = parseTicketFromUrl(new URL(location.href));
const [incoming, setIncoming] = createSignal<ShareLink | null>(pendingUrlShare);
if (pendingUrlShare) clearTicketFromUrl();

const [recvProgress, setRecvProgress] = createSignal({ done: 0, total: 0 });
const [recvError, setRecvError] = createSignal("");
const [recvSaved, setRecvSaved] = createSignal<string | null>(null);

// advanced stats (lazy: loaded when the menu opens)
const [nodeId, setNodeId] = createSignal<string | null>(null);
const [storage, setStorage] = createSignal<StorageEstimate | null>(null);

/** Screen-reader / test status line (same texts as the previous UI). */
const [statusMsg, setStatusMsg] = createSignal("");

const setStatus = (msg: string) => setStatusMsg(msg);

// ==== bandwidth ==============================================================

interface Bandwidth {
  mibps: () => number | null;
  update: (cumulativeBytes: number) => void;
  reset: () => void;
}

function createBandwidth(): Bandwidth {
  const [mibps, setMbps] = createSignal<number | null>(null);
  let last: { t: number; b: number } | null = null;
  return {
    mibps,
    update(bytes) {
      const now = performance.now();
      if (last) {
        const dt = (now - last.t) / 1000;
        if (dt < 0.25) return;
        setMbps(Math.max(0, (bytes - last.b) / dt / (1024 * 1024)));
      }
      last = { t: now, b: bytes };
    },
    reset() {
      last = null;
      setMbps(null);
    },
  };
}

export const bwSend = createBandwidth();
export const bwRecv = createBandwidth();

// ==== node ===================================================================

export async function startNode(): Promise<void> {
  if (nodeStatus() === "ready") return;
  setNodeStatus("connecting");
  setStatus("starting node…");
  try {
    await rpc.call({ kind: "spawn" });
    setNodeStatus("ready");
    setStatus("node ready");
    const pending = incoming();
    if (pending) void doReceive(pending.ticket, pending.name);
  } catch (err) {
    setNodeStatus("error");
    setNodeError(String(err));
    setStatus(`error: ${err}`);
  }
}

// ==== sending ================================================================

/** Auto-sends as soon as a file is picked (no extra button). */
export async function sendSelected(file: File): Promise<void> {
  if (nodeStatus() !== "ready" || sendState() === "importing") return;
  batch(() => {
    setTicket(null);
    setLink("");
    setCopied(false);
    setSendError("");
    setFileMeta({ name: file.name, size: file.size });
    setSendProgress({ done: 0, total: file.size });
    setSendState("importing");
  });
  bwSend.reset();
  setStatus(`sending ${file.name}…`);
  try {
    const t = await sendFile(rpc, file, (p) => {
      setSendProgress({ done: p.bytesDone, total: p.bytesTotal });
      bwSend.update(p.bytesDone);
    });
    const short = await rpc.call<string>({ kind: "short_ticket", ticket: t });
    batch(() => {
      setTicket(t);
      setLink(encodeLink(short, file.name));
      setSendState("ready");
    });
    setStatus("ticket ready");
  } catch (err) {
    batch(() => {
      setSendError(String(err));
      setSendState("error");
    });
    setStatus(`send error: ${err}`);
  }
}

export function resetSend(): void {
  batch(() => {
    setSendState("idle");
    setFileMeta(null);
    setTicket(null);
    setLink("");
    setCopied(false);
    setSendError("");
    setSendProgress({ done: 0, total: 0 });
  });
  bwSend.reset();
}

export const canShare = () => typeof navigator.share === "function";

/** Native share sheet on mobile, clipboard fallback otherwise. */
export async function shareLink(): Promise<void> {
  const l = link();
  if (!l) return;
  if (canShare()) {
    try {
      await navigator.share({ title: "sendblob", url: l });
      return;
    } catch {
      return; // user cancelled the share sheet
    }
  }
  await copyLink();
}

export async function copyLink(): Promise<void> {
  const l = link();
  if (!l) return;
  await navigator.clipboard.writeText(l);
  setCopied(true);
  setStatus("link copied");
  setTimeout(() => setCopied(false), 1600);
}

// ==== receiving ==============================================================

export async function doReceive(ticket: string, name?: string | null): Promise<void> {
  if (!ticket.trim()) return;
  batch(() => {
    setIncoming({ ticket, name: name ?? null });
    setRecvProgress({ done: 0, total: 0 });
    setRecvError("");
    setRecvSaved(null);
  });
  bwRecv.reset();
  setStatus("downloading…");
  try {
    const f = await receiveFile(
      rpc,
      ticket,
      (p) => {
        setRecvProgress({ done: p.bytesDone, total: p.bytesTotal });
        bwRecv.update(p.bytesDone);
      },
      {
        onRetry: (attempt, err) => {
          bwRecv.reset();
          setStatus(`retry ${attempt}/${DEFAULT_MAX_ATTEMPTS}: ${err}`);
        },
      },
    );
    const finalName = name || `sendblob-${f.hash.slice(0, 8)}.bin`;
    await f.save(finalName);
    setRecvSaved(finalName);
    setStatus(`file saved: ${finalName}`);
  } catch (err) {
    setRecvError(String(err));
    setStatus(`receive error: ${err}`);
  }
}

export function resetIncoming(): void {
  setIncoming(null);
  setRecvError("");
  setRecvSaved(null);
  setRecvProgress({ done: 0, total: 0 });
  bwRecv.reset();
}

// ==== advanced stats =========================================================

export async function loadAdvanced(): Promise<void> {
  if (nodeId() === null) {
    rpc
      .call<string>({ kind: "endpoint_id" })
      .then(setNodeId)
      .catch(() => setNodeId("(unavailable)"));
  }
  rpc
    .call<StorageEstimate>({ kind: "storage_estimate" })
    .then(setStorage)
    .catch(() => setStorage(null));
}

// ==== exports ================================================================

export {
  nodeStatus,
  nodeError,
  sendState,
  sendError,
  fileMeta,
  sendProgress,
  ticket,
  link,
  copied,
  incoming,
  recvProgress,
  recvError,
  recvSaved,
  nodeId,
  storage,
  statusMsg,
};

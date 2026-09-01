import "./style.css";
import { WorkerRpc } from "./protocol";
import { receiveFile, sendFile, type ReceivedFile } from "./transfer";
import { clearTicketFromUrl, encodeLink, parseTicketFromUrl } from "./ticket";

const app = document.querySelector<HTMLDivElement>("#app")!;

app.innerHTML = `
  <main class="mx-auto flex h-full max-w-2xl flex-col gap-6 px-4 py-8">
    <header class="text-center">
      <h1 class="text-4xl font-bold tracking-tight">⚡ sendblob</h1>
      <p class="mt-1 text-sm text-slate-400">Phase 2 — P2P file transfer (OPFS store, up to several GiB)</p>
    </header>

    <section class="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div>
        <div class="text-xs uppercase tracking-wide text-slate-500">Node</div>
        <div id="node-id" class="font-mono text-sm text-slate-300">not started</div>
      </div>
      <button id="btn-start" class="rounded-lg bg-sky-600 px-4 py-2 font-medium text-white transition hover:bg-sky-500">
        Start
      </button>
    </section>

    <section class="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <h2 class="mb-2 font-semibold">Send a file</h2>
      <div id="drop-zone"
        class="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-slate-700 p-6 text-center transition hover:border-sky-500">
        <span class="text-sm text-slate-300">Drop a file here, or click to browse</span>
        <span id="file-name" class="font-mono text-xs text-slate-500"></span>
        <input id="file-input" type="file" class="hidden" />
      </div>
      <button id="btn-send" disabled
        class="mt-3 w-full rounded-lg bg-emerald-600 px-4 py-2 font-medium text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40">
        Share
      </button>
      <div class="mt-2 h-2 overflow-hidden rounded bg-slate-800">
        <div id="send-bar" class="h-full w-0 bg-emerald-500 transition-all"></div>
      </div>
      <div id="ticket-out" class="mt-3 hidden break-all rounded-lg bg-slate-950 p-3 font-mono text-xs text-emerald-300"></div>
      <button id="btn-copy-link" hidden
        class="mt-2 w-full rounded-lg bg-sky-600 px-4 py-2 font-medium text-white transition hover:bg-sky-500">
        Copy link
      </button>
    </section>

    <section class="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <h2 class="mb-2 font-semibold">Receive</h2>
      <input id="ticket-in" placeholder="Paste a ticket…"
        class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-xs outline-none focus:border-sky-500" />
      <div class="mt-2 flex items-center gap-3">
        <input id="filename-in" placeholder="Filename (default: sendblob-<hash>.bin)"
          class="w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm outline-none focus:border-sky-500" />
        <button id="btn-receive" class="shrink-0 rounded-lg bg-sky-600 px-4 py-2 font-medium text-white transition hover:bg-sky-500">
          Receive
        </button>
      </div>
      <div class="mt-3 h-2 overflow-hidden rounded bg-slate-800">
        <div id="recv-bar" class="h-full w-0 bg-sky-500 transition-all"></div>
      </div>
      <div class="mt-2 flex items-center justify-between">
        <span id="recv-progress" class="text-xs text-slate-400"></span>
        <button id="btn-save" hidden
          class="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-500">
          Save file
        </button>
      </div>
    </section>

    <section class="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <h2 class="mb-2 font-semibold">Text (phase 1 spike)</h2>
      <textarea id="share-text" rows="2" placeholder="Text to share…"
        class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm outline-none focus:border-sky-500"></textarea>
      <div class="mt-2 flex items-center gap-2">
        <button id="btn-share" class="rounded-lg bg-emerald-600 px-4 py-2 font-medium text-white transition hover:bg-emerald-500">
          Share
        </button>
        <input id="text-ticket-in" placeholder="Paste a text ticket…"
          class="w-full rounded-lg border border-slate-700 bg-slate-950 p-2 font-mono text-xs outline-none focus:border-sky-500" />
        <button id="btn-receive-text" class="shrink-0 rounded-lg bg-sky-600 px-4 py-2 font-medium text-white transition hover:bg-sky-500">
          Receive
        </button>
      </div>
      <pre id="text-out" class="mt-3 hidden max-h-40 overflow-auto rounded-lg bg-slate-950 p-3 text-sm text-slate-200"></pre>
    </section>

    <section class="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <h2 class="mb-2 font-semibold">OPFS bench (S2)</h2>
      <div class="flex flex-wrap gap-2">
        <button data-chunk="1" class="bench-btn rounded-lg border border-slate-700 px-3 py-1.5 text-sm hover:border-sky-500">chunks 1 MiB</button>
        <button data-chunk="4" class="bench-btn rounded-lg border border-slate-700 px-3 py-1.5 text-sm hover:border-sky-500">chunks 4 MiB</button>
        <button data-chunk="8" class="bench-btn rounded-lg border border-slate-700 px-3 py-1.5 text-sm hover:border-sky-500">chunks 8 MiB</button>
      </div>
      <div id="bench-out" class="mt-3 font-mono text-xs text-slate-300"></div>
    </section>

    <p id="global-status" class="text-center text-xs text-slate-500"></p>
  </main>
`;

const rpc = new WorkerRpc();
const $ = <T extends HTMLElement = HTMLDivElement>(sel: string) =>
  document.querySelector<T>(sel)!;
const input = (sel: string) => document.querySelector<HTMLInputElement>(sel)!;
const setStatus = (msg: string) => ($(" #global-status").textContent = msg);

const fmtBytes = (n: number) => {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${n} B`;
};

const setBar = (sel: string, done: number, total: number) => {
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  $(sel).style.width = `${pct}%`;
};

// ==== node ===================================================================

const btnStart = document.querySelector<HTMLButtonElement>("#btn-start")!;
let started = false;

const startNode = async (): Promise<void> => {
  setStatus("starting node…");
  try {
    await rpc.call({ kind: "spawn" });
    const id = await rpc.call<string>({ kind: "endpoint_id" });
    $(" #node-id").textContent = id;
    btnStart.disabled = true;
    started = true;
    setStatus("node ready ✔");
  } catch (err) {
    setStatus(`error: ${err}`);
  }
};

btnStart.addEventListener("click", () => startNode());

// ==== file sending ==========================================================

const dropZone = $(" #drop-zone");
const fileInput = input("#file-input");
let selectedFile: File | null = null;

const selectFile = (file: File) => {
  selectedFile = file;
  $(" #file-name").textContent = `${file.name} (${fmtBytes(file.size)})`;
  document.querySelector<HTMLButtonElement>("#btn-send")!.disabled = !started;
};

dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files?.[0]) selectFile(fileInput.files[0]);
});
dropZone.addEventListener("dragover", (ev) => {
  ev.preventDefault();
  dropZone.classList.add("border-sky-500");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("border-sky-500"));
dropZone.addEventListener("drop", (ev) => {
  ev.preventDefault();
  dropZone.classList.remove("border-sky-500");
  const file = ev.dataTransfer?.files?.[0];
  if (file) selectFile(file);
});

let receivedFile: ReceivedFile | null = null;

$(" #btn-send").addEventListener("click", async () => {
  if (!selectedFile || !started) return;
  const file = selectedFile;
  try {
    setStatus(`sending ${file.name}…`);
    $(" #ticket-out").classList.add("hidden");
    $(" #btn-copy-link").hidden = true;
    const ticket = await sendFile(rpc, file, (p) => {
      setBar(" #send-bar", p.bytesDone, p.bytesTotal);
      setStatus(`send: ${fmtBytes(p.bytesDone)} / ${fmtBytes(p.bytesTotal)}`);
    });
    const out = $(" #ticket-out");
    out.textContent = ticket;
    out.classList.remove("hidden");
    ($(" #btn-copy-link") as HTMLButtonElement).dataset.ticket = ticket;
    $(" #btn-copy-link").hidden = false;
    setStatus(`ticket ready — share the link or paste the ticket ✔ (${file.name})`);
  } catch (err) {
    setStatus(`send error: ${err}`);
    $(" #send-bar").style.width = "0%";
  }
});

$(" #btn-copy-link").addEventListener("click", async (ev) => {
  const ticket = (ev.currentTarget as HTMLButtonElement).dataset.ticket;
  if (!ticket) return;
  try {
    const short = await rpc.call<string>({ kind: "short_ticket", ticket });
    await navigator.clipboard.writeText(encodeLink(short));
    setStatus("link copied ✔ — it contains no server-side state");
  } catch (err) {
    setStatus(`error: ${err}`);
  }
});

// ==== file receiving ========================================================

$(" #btn-receive").addEventListener("click", async () => {
  const ticket = input("#ticket-in").value.trim();
  if (!ticket || !started) return;
  const saveBtn = input("#btn-save") as HTMLButtonElement;
  receivedFile = null;
  saveBtn.hidden = true;
  $(" #recv-bar").style.width = "0%";
  try {
    setStatus("downloading…");
    receivedFile = await receiveFile(rpc, ticket, (p) => {
      setBar(" #recv-bar", p.bytesDone, p.bytesTotal);
      setStatus(
        p.bytesTotal > 1
          ? `receive: ${fmtBytes(p.bytesDone)} / ${fmtBytes(p.bytesTotal)}`
          : `receive: ${fmtBytes(p.bytesDone)}`,
      );
    });
    setStatus(`file received: ${fmtBytes(receivedFile.size)} ✔`);
    saveBtn.hidden = false;
    // immediate auto-save
    await save();
  } catch (err) {
    setStatus(`receive error: ${err}`);
  }
});

async function save() {
  if (!receivedFile) return;
  const name =
    input("#filename-in").value.trim() ||
    `sendblob-${receivedFile.hash.slice(0, 8)}.bin`;
  try {
    await receivedFile.save(name);
    setStatus(`file saved: ${name} ✔`);
  } catch (err) {
    setStatus(`save error: ${err}`);
  }
}

$(" #btn-save").addEventListener("click", save);

// ==== text spike (phase 1) ===================================================

$(" #btn-share").addEventListener("click", async () => {
  const text = (document.querySelector<HTMLTextAreaElement>("#share-text")!).value;
  if (!text || !started) return;
  try {
    const ticket = await rpc.call<string>({
      kind: "import",
      data: new TextEncoder().encode(text),
    });
    input("#text-ticket-in").value = ticket;
    setStatus("text ticket ready ✔");
  } catch (err) {
    setStatus(`error: ${err}`);
  }
});

$(" #btn-receive-text").addEventListener("click", async () => {
  const ticket = input("#text-ticket-in").value.trim();
  if (!ticket || !started) return;
  try {
    const hash = await rpc.call<string>({ kind: "hash_from_ticket", ticket });
    await rpc.call({ kind: "download", ticket });
    const bytes = await rpc.call<Uint8Array>({ kind: "get", hash });
    const out = $(" #text-out");
    out.textContent = new TextDecoder().decode(bytes);
    out.classList.remove("hidden");
    setStatus(`text received (${bytes.length} bytes) ✔`);
  } catch (err) {
    setStatus(`error: ${err}`);
  }
});

// ==== bench =================================================================

document.querySelectorAll<HTMLButtonElement>(".bench-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const chunkMb = Number(btn.dataset.chunk);
    const out = $(" #bench-out");
    out.textContent = `bench 64 MiB / chunks ${chunkMb} MiB…`;
    try {
      const r = await rpc.call<{ writeMbs: number; readMbs: number }>({
        kind: "bench_opfs",
        sizeMb: 64,
        chunkMb,
      });
      out.textContent = `write ${r.writeMbs.toFixed(0)} MB/s — read ${r.readMbs.toFixed(0)} MB/s (chunks ${chunkMb} MiB)`;
    } catch (err) {
      out.textContent = `error: ${err}`;
    }
  });
});

// ==== share link =============================================================

// A share link (#t=… or #ticket=…) in the address bar: boot the node and
// receive immediately. The fragment is consumed (never leaves the browser).
const pendingTicket = parseTicketFromUrl(new URL(location.href));
if (pendingTicket) {
  clearTicketFromUrl();
  input("#ticket-in").value = pendingTicket;
  void startNode().then(() => {
    if (started && input("#ticket-in").value.trim()) {
      $(" #btn-receive").click();
    }
  });
}

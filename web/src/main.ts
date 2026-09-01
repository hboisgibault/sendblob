import "./style.css";
import { WorkerRpc } from "./protocol";
import { receiveFile, sendFile, type ReceivedFile } from "./transfer";

const app = document.querySelector<HTMLDivElement>("#app")!;

app.innerHTML = `
  <main class="mx-auto flex h-full max-w-2xl flex-col gap-6 px-4 py-8">
    <header class="text-center">
      <h1 class="text-4xl font-bold tracking-tight">⚡ sendblob</h1>
      <p class="mt-1 text-sm text-slate-400">Phase 2 — transfert de fichiers P2P (store OPFS, jusqu'à plusieurs Gio)</p>
    </header>

    <section class="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div>
        <div class="text-xs uppercase tracking-wide text-slate-500">Nœud</div>
        <div id="node-id" class="font-mono text-sm text-slate-300">non démarré</div>
      </div>
      <button id="btn-start" class="rounded-lg bg-sky-600 px-4 py-2 font-medium text-white transition hover:bg-sky-500">
        Démarrer
      </button>
    </section>

    <section class="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <h2 class="mb-2 font-semibold">Envoyer un fichier</h2>
      <div id="drop-zone"
        class="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-slate-700 p-6 text-center transition hover:border-sky-500">
        <span class="text-sm text-slate-300">Glissez un fichier ici, ou cliquez pour choisir</span>
        <span id="file-name" class="font-mono text-xs text-slate-500"></span>
        <input id="file-input" type="file" class="hidden" />
      </div>
      <button id="btn-send" disabled
        class="mt-3 w-full rounded-lg bg-emerald-600 px-4 py-2 font-medium text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40">
        Partager
      </button>
      <div class="mt-2 h-2 overflow-hidden rounded bg-slate-800">
        <div id="send-bar" class="h-full w-0 bg-emerald-500 transition-all"></div>
      </div>
      <div id="ticket-out" class="mt-3 hidden break-all rounded-lg bg-slate-950 p-3 font-mono text-xs text-emerald-300"></div>
    </section>

    <section class="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <h2 class="mb-2 font-semibold">Recevoir</h2>
      <input id="ticket-in" placeholder="Coller un ticket…"
        class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-xs outline-none focus:border-sky-500" />
      <div class="mt-2 flex items-center gap-3">
        <input id="filename-in" placeholder="Nom du fichier (défaut : sendblob-<hash>.bin)"
          class="w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm outline-none focus:border-sky-500" />
        <button id="btn-receive" class="shrink-0 rounded-lg bg-sky-600 px-4 py-2 font-medium text-white transition hover:bg-sky-500">
          Recevoir
        </button>
      </div>
      <div class="mt-3 h-2 overflow-hidden rounded bg-slate-800">
        <div id="recv-bar" class="h-full w-0 bg-sky-500 transition-all"></div>
      </div>
      <div class="mt-2 flex items-center justify-between">
        <span id="recv-progress" class="text-xs text-slate-400"></span>
        <button id="btn-save" hidden
          class="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-500">
          Enregistrer le fichier
        </button>
      </div>
    </section>

    <section class="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <h2 class="mb-2 font-semibold">Texte (spike phase 1)</h2>
      <textarea id="share-text" rows="2" placeholder="Texte à partager…"
        class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm outline-none focus:border-sky-500"></textarea>
      <div class="mt-2 flex items-center gap-2">
        <button id="btn-share" class="rounded-lg bg-emerald-600 px-4 py-2 font-medium text-white transition hover:bg-emerald-500">
          Partager
        </button>
        <input id="text-ticket-in" placeholder="Coller un ticket texte…"
          class="w-full rounded-lg border border-slate-700 bg-slate-950 p-2 font-mono text-xs outline-none focus:border-sky-500" />
        <button id="btn-receive-text" class="shrink-0 rounded-lg bg-sky-600 px-4 py-2 font-medium text-white transition hover:bg-sky-500">
          Recevoir
        </button>
      </div>
      <pre id="text-out" class="mt-3 hidden max-h-40 overflow-auto rounded-lg bg-slate-950 p-3 text-sm text-slate-200"></pre>
    </section>

    <section class="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <h2 class="mb-2 font-semibold">Bench OPFS (S2)</h2>
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
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} Gio`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} Mio`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} Kio`;
  return `${n} o`;
};

const setBar = (sel: string, done: number, total: number) => {
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  $(sel).style.width = `${pct}%`;
};

// ==== nœud ==================================================================

const btnStart = document.querySelector<HTMLButtonElement>("#btn-start")!;
let started = false;
btnStart.addEventListener("click", async () => {
  setStatus("démarrage du nœud…");
  try {
    await rpc.call({ kind: "spawn" });
    const id = await rpc.call<string>({ kind: "endpoint_id" });
    $(" #node-id").textContent = id;
    btnStart.disabled = true;
    started = true;
    setStatus("nœud prêt ✔");
  } catch (err) {
    setStatus(`erreur : ${err}`);
  }
});

// ==== envoi de fichier ======================================================

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
    setStatus(`envoi de ${file.name}…`);
    $(" #ticket-out").classList.add("hidden");
    const ticket = await sendFile(rpc, file, (p) => {
      setBar(" #send-bar", p.bytesDone, p.bytesTotal);
      setStatus(`envoi : ${fmtBytes(p.bytesDone)} / ${fmtBytes(p.bytesTotal)}`);
    });
    const out = $(" #ticket-out");
    out.textContent = ticket;
    out.classList.remove("hidden");
    setStatus(`ticket prêt — colle-le dans l'autre onglet ✔ (${file.name})`);
  } catch (err) {
    setStatus(`erreur d'envoi : ${err}`);
    $(" #send-bar").style.width = "0%";
  }
});

// ==== réception de fichier ==================================================

$(" #btn-receive").addEventListener("click", async () => {
  const ticket = input("#ticket-in").value.trim();
  if (!ticket || !started) return;
  const saveBtn = input("#btn-save") as HTMLButtonElement;
  receivedFile = null;
  saveBtn.hidden = true;
  $(" #recv-bar").style.width = "0%";
  try {
    setStatus("téléchargement…");
    receivedFile = await receiveFile(rpc, ticket, (p) => {
      setBar(" #recv-bar", p.bytesDone, p.bytesTotal);
      setStatus(
        p.bytesTotal > 1
          ? `réception : ${fmtBytes(p.bytesDone)} / ${fmtBytes(p.bytesTotal)}`
          : `réception : ${fmtBytes(p.bytesDone)}`,
      );
    });
    setStatus(`fichier reçu : ${fmtBytes(receivedFile.size)} ✔`);
    saveBtn.hidden = false;
    // sauvegarde automatique immédiate
    await save();
  } catch (err) {
    setStatus(`erreur de réception : ${err}`);
  }
});

async function save() {
  if (!receivedFile) return;
  const name =
    input("#filename-in").value.trim() ||
    `sendblob-${receivedFile.hash.slice(0, 8)}.bin`;
  try {
    await receivedFile.save(name);
    setStatus(`fichier enregistré : ${name} ✔`);
  } catch (err) {
    setStatus(`erreur de sauvegarde : ${err}`);
  }
}

$(" #btn-save").addEventListener("click", save);

// ==== spike texte (phase 1) =================================================

$(" #btn-share").addEventListener("click", async () => {
  const text = (document.querySelector<HTMLTextAreaElement>("#share-text")!).value;
  if (!text || !started) return;
  try {
    const ticket = await rpc.call<string>({
      kind: "import",
      data: new TextEncoder().encode(text),
    });
    input("#text-ticket-in").value = ticket;
    setStatus("ticket texte prêt ✔");
  } catch (err) {
    setStatus(`erreur : ${err}`);
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
    setStatus(`texte reçu (${bytes.length} octets) ✔`);
  } catch (err) {
    setStatus(`erreur : ${err}`);
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
      out.textContent = `écriture ${r.writeMbs.toFixed(0)} Mo/s — lecture ${r.readMbs.toFixed(0)} Mo/s (chunks ${chunkMb} MiB)`;
    } catch (err) {
      out.textContent = `erreur : ${err}`;
    }
  });
});

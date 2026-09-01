import "./style.css";
import { WorkerRpc } from "./protocol";

const app = document.querySelector<HTMLDivElement>("#app")!;

app.innerHTML = `
  <main class="mx-auto flex h-full max-w-2xl flex-col gap-6 px-4 py-8">
    <header class="text-center">
      <h1 class="text-4xl font-bold tracking-tight">⚡ sendblob</h1>
      <p class="mt-1 text-sm text-slate-400">Spike phase 1 — transfert texte P2P (iroh-blobs in-memory)</p>
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
      <h2 class="mb-2 font-semibold">Partager un texte</h2>
      <textarea id="share-text" rows="3" placeholder="Texte à partager…"
        class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm outline-none focus:border-sky-500"></textarea>
      <button id="btn-share" class="mt-2 rounded-lg bg-emerald-600 px-4 py-2 font-medium text-white transition hover:bg-emerald-500">
        Partager
      </button>
      <div id="ticket-out" class="mt-3 hidden break-all rounded-lg bg-slate-950 p-3 font-mono text-xs text-emerald-300"></div>
    </section>

    <section class="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <h2 class="mb-2 font-semibold">Recevoir</h2>
      <input id="ticket-in" placeholder="Coller un ticket…"
        class="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-xs outline-none focus:border-sky-500" />
      <div class="mt-2 flex items-center gap-3">
        <button id="btn-receive" class="rounded-lg bg-sky-600 px-4 py-2 font-medium text-white transition hover:bg-sky-500">
          Recevoir
        </button>
        <span id="recv-progress" class="text-xs text-slate-400"></span>
      </div>
      <pre id="recv-out" class="mt-3 hidden max-h-40 overflow-auto rounded-lg bg-slate-950 p-3 text-sm text-slate-200"></pre>
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
const textarea = (sel: string) => document.querySelector<HTMLTextAreaElement>(sel)!;
const input = (sel: string) => document.querySelector<HTMLInputElement>(sel)!;
const setStatus = (msg: string) => ($(" #global-status").textContent = msg);

$(" #btn-start").addEventListener("click", async () => {
  setStatus("démarrage du nœud…");
  try {
    await rpc.call({ kind: "spawn" });
    const id = await rpc.call<string>({ kind: "endpoint_id" });
    $(" #node-id").textContent = id;
    setStatus("nœud prêt ✔");
  } catch (err) {
    setStatus(`erreur : ${err}`);
  }
});

$(" #btn-share").addEventListener("click", async () => {
  const text = textarea("#share-text").value;
  if (!text) return;
  try {
    setStatus("publication…");
    const ticket = await rpc.call<string>({
      kind: "import",
      data: new TextEncoder().encode(text),
    });
    const out = $(" #ticket-out");
    out.textContent = ticket;
    out.classList.remove("hidden");
    setStatus("ticket prêt — colle-le dans l'autre onglet ✔");
  } catch (err) {
    setStatus(`erreur : ${err}`);
  }
});

$(" #btn-receive").addEventListener("click", async () => {
  const ticket = input("#ticket-in").value.trim();
  if (!ticket) return;
  try {
    const hash = await rpc.call<string>({ kind: "hash_from_ticket", ticket });
    const progress = $(" #recv-progress");
    const poll = setInterval(async () => {
      try {
        const st = await rpc.call<string>({ kind: "status", hash });
        progress.textContent = st === "not_found" ? "en attente…" : st;
      } catch {
        /* poll next */
      }
    }, 300);
    await rpc.call({ kind: "download", ticket });
    clearInterval(poll);
    const bytes = await rpc.call<Uint8Array>({ kind: "get", hash });
    const out = $(" #recv-out");
    out.textContent = new TextDecoder().decode(bytes);
    out.classList.remove("hidden");
    progress.textContent = `✔ ${bytes.length} octets`;
  } catch (err) {
    setStatus(`erreur : ${err}`);
  }
});

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

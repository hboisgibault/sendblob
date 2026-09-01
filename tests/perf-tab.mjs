import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

// Perf measurement: 2 tabs, same machine, one large file.
// Progress is captured at the source (worker -> main thread postMessage)
// via an init script that records every worker message with a timestamp.

const FILE = process.argv[2] ?? "/tmp/opfs/test-173m.bin";
const URL = process.argv[3] ?? "http://localhost:4173/";
const data = readFileSync(FILE);
const MB = data.length / (1024 * 1024);
console.log(`file: ${FILE} (${MB.toFixed(1)} MB)`);

// capture all worker messages in window.__workerLog (main-side, timestamped)
const INIT = `
  window.__workerLog = [];
  (() => {
    const origWorker = window.Worker;
    window.Worker = class extends origWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', (ev) => {
          const d = ev.data ?? {};
          if (d && typeof d === 'object') {
            window.__workerLog.push({ t: performance.now(), kind: d.event ?? d.kind ?? '?', bytesDone: d.bytesDone, bytesTotal: d.bytesTotal, ok: d.ok });
          }
        });
      }
    };
  })();
`;

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-first-run"],
});
const context = await browser.newContext({ acceptDownloads: true });
context.setDefaultTimeout(300_000);
await context.addInitScript(INIT);

const cpuTop = () => {
  try {
    return execSync(
      "ps -eo %cpu,comm,args --no-headers | grep -E 'chrome.*--type=renderer' | sort -rn | head -3 | awk '{printf \"%s%% %s | \", $1, $3}'",
    ).toString().trim();
  } catch {
    return "?";
  }
};

const newTab = async (label) => {
  const page = await context.newPage();
  page.on("pageerror", (err) => console.log(`[${label}] pageerror:`, err.message));
  await page.goto(URL);
  await page.waitForSelector('#node-status[data-state="ready"]', { timeout: 60_000 });
  console.log(`[${label}] node ready`);
  return page;
};

// 1. both tabs
const a = await newTab("A");
const b = await newTab("B");

// 2. A imports (wasm + OPFS only, no network)
const t0 = Date.now();
await a.setInputFiles("#file-input", FILE);
await a.getByText("Ready to share").waitFor({ timeout: 300_000 });
const tImport = (Date.now() - t0) / 1000;
console.log(`[A] t_import (wasm+OPFS): ${tImport.toFixed(2)} s (${(MB / tImport).toFixed(1)} MB/s)`);

const ticket = await a.evaluate(() => document.getElementById("ticket-out").textContent);

// 3. B receives; sample CPU in parallel; then extract the progress trace
const toggle = b.getByRole("button", { name: "Paste a ticket instead" });
if (await toggle.isVisible().catch(() => false)) await toggle.click();
await b.fill("#ticket-in", ticket);
const t1 = Date.now();
await b.click("#btn-receive");
await b.getByText(/file (saved|received)/).waitFor({ timeout: 600_000 });
const tTotal = (Date.now() - t1) / 1000;
const cpuDuring = cpuTop();
console.log(`[B] t_download (receive+save): ${tTotal.toFixed(2)} s (${(MB / tTotal).toFixed(1)} MB/s)`);
console.log(`[cpu] top renderers at end: ${cpuDuring}`);

// 4. progress trace from the worker log (progress events of the receive)
const log = await b.evaluate(() => window.__workerLog);
const prog = log.filter((m) => m.kind === "progress");
console.log(`[B] worker log: ${log.length} messages, ${prog.length} progress events`);
if (prog.length) {
  const tAbs0 = prog[0].t;
  const pts = prog.map((m) => ({ dt: (m.t - tAbs0) / 1000, done: m.bytesDone ?? 0, total: m.bytesTotal }));
  const first = pts[0];
  const last = pts[pts.length - 1];
  const ttfb = first.dt;
  const tNet = last.dt - first.dt;
  console.log(`[B] TTFB (click->first progress): ${(tAbs0 / 1000).toFixed(2)} s from page load; first bytesDone=${first.done}`);
  console.log(`[B] net window: ${tNet.toFixed(2)} s for ${((last.done - first.done) / (1024 * 1024)).toFixed(1)} MB -> ${((last.done - first.done) / tNet / (1024 * 1024)).toFixed(2)} MB/s`);
  console.log(`[B] tail (last progress -> file saved): ${(tTotal - last.dt / 1000).toFixed(2)} s`);
  // throughput curve: bytesDone every ~2 s of trace
  const marks = [];
  for (let s = 0; s <= last.dt; s += 2) {
    const p = [...pts].reverse().find((x) => x.dt <= s) ?? pts[0];
    marks.push(`${s}s:${(p.done / (1024 * 1024)).toFixed(0)}MB`);
  }
  console.log(`[B] curve: ${marks.join(" ")}`);
  // count of progress events (UI storm check)
  console.log(`[B] progress events total: ${pts.length} (chunk-level if > 10k)`);
}

await browser.close();
console.log("OK: perf-tab done");

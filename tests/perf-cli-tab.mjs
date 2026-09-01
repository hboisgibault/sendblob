import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

// Perf: native CLI provider -> browser tab receiver.
// Usage: node tests/perf-cli-tab.mjs <ticket> [file]

const TICKET = process.argv[2];
const FILE = process.argv[3] ?? "/tmp/opfs/test-173m.bin";
const URL = process.env.URL ?? "http://localhost:4173/";
const MB = readFileSync(FILE).length / (1024 * 1024);
console.log(`file: ${MB.toFixed(1)} MB`);

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

const page = await context.newPage();
page.on("pageerror", (err) => console.log("pageerror:", err.message));
await page.goto(URL);
await page.waitForSelector('#node-status[data-state="ready"]', { timeout: 60_000 });
console.log("node ready");

const toggle = page.getByRole("button", { name: "Paste a ticket instead" });
if (await toggle.isVisible().catch(() => false)) await toggle.click();
await page.fill("#ticket-in", TICKET);
const t1 = Date.now();
await page.click("#btn-receive");
await page.getByText(/file (saved|received)/).waitFor({ timeout: 600_000 });
const tTotal = (Date.now() - t1) / 1000;
console.log(`[tab] t_download: ${tTotal.toFixed(2)} s (${(MB / tTotal).toFixed(1)} MB/s)`);

const log = await page.evaluate(() => window.__workerLog);
const prog = log.filter((m) => m.kind === "progress");
if (prog.length) {
  const pts = prog.map((m) => ({ dt: m.t / 1000, done: m.bytesDone ?? 0 }));
  const first = pts.find((p) => p.done > 0) ?? pts[0];
  const last = pts[pts.length - 1];
  console.log(`[tab] net window: ${(last.dt - first.dt).toFixed(2)} s -> ${((last.done - first.done) / (last.dt - first.dt) / (1024 * 1024)).toFixed(2)} MB/s`);
  console.log(`[tab] progress events: ${pts.length}`);
}
await browser.close();
console.log("OK: perf-cli-tab done");

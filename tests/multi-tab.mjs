import { chromium } from "playwright";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 2 tabs, same context (same origin: shared OPFS + Web Locks):
// 1. both nodes start (B's purge must not kill A's store)
// 2. file transfer A -> B (true browser↔browser on a single device)
// 3. reload A (new tabId, old directory purged)
// 4. transfer A -> B again (B survives A's purge)

const tmp = mkdtempSync(join(tmpdir(), "sendblob-e2e-"));
const file1 = join(tmp, "doc-a.bin");
const file2 = join(tmp, "doc-b.bin");
writeFileSync(file1, Buffer.from(`A-${Date.now()}`.padEnd(4096, "x")));
writeFileSync(file2, Buffer.from(`B-${Date.now()}`.padEnd(8192, "y")));

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-first-run"],
});
const context = await browser.newContext({ acceptDownloads: true });
context.setDefaultTimeout(60_000);

const newTab = async (label) => {
  const page = await context.newPage();
  page.on("pageerror", (err) => console.log(`[${label}] pageerror:`, err.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[${label}] console:`, m.text().slice(0, 200));
  });
  await page.goto("http://localhost:5173/");
  // the node starts by itself (no start button)
  await page.waitForSelector('#node-status[data-state="ready"]');
  console.log(`[${label}] node ready`);
  return page;
};

const send = async (page, label, path) => {
  await page.setInputFiles("#file-input", path);
  await page.getByText("Ready to share").waitFor();
  const ticket = await page.evaluate(() => document.getElementById("ticket-out").textContent);
  console.log(`[${label}] ticket: ${ticket.slice(0, 24)}…`);
  return ticket;
};

const receive = async (page, label, ticket) => {
  const toggle = page.getByRole("button", { name: "Paste a ticket instead" });
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  await page.fill("#ticket-in", ticket);
  await page.click("#btn-receive");
  await page.getByText(/file (saved|received)/).waitFor();
  const status = await page.evaluate(() => document.getElementById("global-status").textContent);
  console.log(`[${label}] ${status}`);
};

const opfsDirs = async (page) =>
  page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("sendblob");
    const names = [];
    for await (const name of dir.keys()) names.push(name);
    return names;
  });

// 1. both tabs start
const a = await newTab("A");
const b = await newTab("B");
const dirs = await opfsDirs(a);
console.log(`OPFS directories: ${dirs.length} (expected 2)`);
if (dirs.length !== 2) throw new Error(`OPFS: got ${dirs.length} directories instead of 2`);

// 2. transfer A -> B
await receive(b, "B", await send(a, "A", file1));

// 3. reload A
await a.reload();
await a.waitForSelector('#node-status[data-state="ready"]');
console.log("[A] node ready after reload");
const dirsAfter = await opfsDirs(a);
console.log(`OPFS directories after reload: ${dirsAfter.length} (expected 2)`);
if (dirsAfter.length !== 2)
  throw new Error(`OPFS after reload: got ${dirsAfter.length} directories instead of 2`);

// 4. transfer A -> B after reload
await receive(b, "B", await send(a, "A", file2));

await browser.close();
console.log("OK: multi-tab validated");

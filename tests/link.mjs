import { chromium } from "playwright";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Phase 3: share link (#t=<compact ticket>)
// 1. tab A sends a file and copies the link
// 2. the link is short (#t=…, 88-char compact payload, no server state)
// 3. tab B opens the link: node auto-starts, file auto-receives
// 4. the fragment is consumed from the address bar

const tmp = mkdtempSync(join(tmpdir(), "sendblob-link-"));
const file1 = join(tmp, "link-doc.bin");
writeFileSync(file1, Buffer.from(`link-${Date.now()}`.padEnd(6144, "z")));

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-first-run"],
});
const context = await browser.newContext({ acceptDownloads: true });
context.setDefaultTimeout(60_000);
await context.grantPermissions(["clipboard-read", "clipboard-write"]);

const newTab = async (label) => {
  const page = await context.newPage();
  page.on("pageerror", (err) => console.log(`[${label}] pageerror:`, err.message));
  await page.goto("http://localhost:5173/");
  await page.getByRole("button", { name: "Start" }).click();
  await page.getByText("node ready").waitFor();
  console.log(`[${label}] node ready`);
  return page;
};

// 1. A sends and copies the link
const a = await newTab("A");
await a.setInputFiles("#file-input", file1);
await a.click("#btn-send");
await a.getByText("ticket ready").waitFor();
await a.click("#btn-copy-link");
await a.getByText("link copied").waitFor();
const link = await a.evaluate(() => navigator.clipboard.readText());
console.log(`[A] link: ${link}`);

// 2. shape: origin + #t= + 88 base64url chars (no blob ticket, no server path)
const m = link.match(/^http:\/\/[^#]+#t=([A-Za-z0-9_-]{88})$/);
if (!m) throw new Error(`unexpected link shape: ${link}`);
if (link.length > 140) throw new Error(`link too long: ${link.length} chars`);

// 3. B opens the link: auto start + receive
const b = await context.newPage();
b.on("pageerror", (err) => console.log(`[B] pageerror:`, err.message));
await b.goto(link);
await b.getByText(/file (saved|received)/).waitFor();
const status = await b.evaluate(() => document.getElementById("global-status").textContent);
console.log(`[B] ${status}`);

// 4. fragment consumed
const hash = await b.evaluate(() => location.hash);
if (hash !== "") throw new Error(`fragment not consumed: ${hash}`);

await browser.close();
console.log("OK: share link validated");

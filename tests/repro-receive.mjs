import { chromium } from "playwright";

const TICKET = process.argv[2];
if (!TICKET) {
  console.error("usage: node tests/repro-receive.mjs <ticket>");
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--enable-logging=stderr", "--v=0", "--no-first-run"],
});

const context = await browser.newContext();
const page = await context.newPage();

page.on("crash", () => {
  console.log("!!! PAGE CRASHED");
});
page.on("pageerror", (err) => console.log("pageerror:", err.message));
page.on("console", (msg) => {
  if (msg.type() === "error" || msg.type() === "warning") {
    console.log(`console[${msg.type()}]:`, msg.text().slice(0, 300));
  }
});
page.on("download", (d) => console.log("download event:", d.suggestedFilename()));

await page.goto("http://localhost:5173/");
// the node starts by itself (no start button)
await page.waitForSelector('#node-status[data-state="ready"]', { timeout: 30_000 });
console.log("node ready");

const toggle = page.getByRole("button", { name: "Paste a ticket instead" });
if (await toggle.isVisible().catch(() => false)) await toggle.click();
await page.fill("#ticket-in", TICKET);
await page.click("#btn-receive");
console.log("receive clicked, waiting…");

// watch the status until success/failure/crash
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const status = await page
    .evaluate(() => document.getElementById("global-status")?.textContent ?? "?")
    .catch((e) => `EVAL-FAIL: ${e.message.split("\n")[0]}`);
  console.log(`[${((Date.now() - (deadline - 120_000)) / 1000).toFixed(1)}s] status:`, status);
  if (
    typeof status === "string" &&
    (status.includes("file saved") || status.includes("error"))
  ) {
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}

await browser.close().catch(() => {});
console.log("done");

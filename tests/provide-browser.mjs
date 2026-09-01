import { chromium } from "playwright";

const FILE = process.argv[2];
if (!FILE) {
  console.error("usage: node tests/provide-browser.mjs <file>");
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-first-run"],
});

const context = await browser.newContext();
const page = await context.newPage();
page.on("pageerror", (err) => console.log("pageerror:", err.message));

await page.goto(process.env.URL ?? "http://localhost:5173/");
// the node starts by itself (no start button)
await page.waitForSelector('#node-status[data-state="ready"]', { timeout: 30_000 });
console.log("node ready");

await page.setInputFiles("#file-input", FILE);
await page.getByText("Ready to share").waitFor({ timeout: 60_000 });
// the ticket is in the hidden #ticket-out as soon as the QR shows
const ticket = await page.evaluate(
  () => document.getElementById("ticket-out")?.textContent ?? "",
);
console.log("TICKET=" + ticket);

// stay open for 3 min to serve the blob
await new Promise((r) => setTimeout(r, 180_000));
await browser.close();

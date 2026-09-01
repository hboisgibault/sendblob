import { chromium } from "playwright";

const FILE = process.argv[2];
if (!FILE) {
  console.error("usage: node tests/provide-browser.mjs <fichier>");
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

await page.goto("http://localhost:5173/");
await page.getByRole("button", { name: "Démarrer" }).click();
await page.getByText("nœud prêt").waitFor({ timeout: 30_000 });
console.log("node ready");

await page.setInputFiles("#file-input", FILE);
await page.click("#btn-send");
const ticket = await page
  .getByRole("paragraph")
  .filter({ hasText: "ticket prêt" })
  .waitFor({ timeout: 60_000 })
  .then(async () => {
    // le ticket est dans #ticket-out dès que le statut affiche "ticket prêt"
    return page.evaluate(() => document.getElementById("ticket-out")?.textContent ?? "");
  });
console.log("TICKET=" + ticket);

// reste ouvert 3 min pour servir le blob
await new Promise((r) => setTimeout(r, 180_000));
await browser.close();

// Screenshot of the deployed PWA after one live confidential request.
// CONF_TEST_KEY=sk-... OUT=/path node scripts/shot-live.mjs   (key is never printed)
import { chromium } from "playwright";
const URL = process.env.URL ?? "https://jooray.github.io/routstr-confidential-pwa/?prewarm=0";
const key = process.env.CONF_TEST_KEY;
if (!key) throw new Error("CONF_TEST_KEY is not set");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })).newPage();
await page.goto(URL);
await page.waitForFunction(() => /offer verified/.test(document.getElementById("offer-pill")?.textContent ?? ""), null, { timeout: 30000 });
await page.selectOption("#model", process.env.MODEL ?? "deepseek-v4-flash-0731");
await page.fill("#max-tokens", "300"); await page.dispatchEvent("#max-tokens", "change");
await page.locator("summary", { hasText: "Use an existing key" }).click();
await page.fill("#paste-key", key);
await page.locator("button", { hasText: "Use key" }).click();
await page.fill("#paste-key", "");
await page.fill("#prompt", process.env.PROMPT ?? "In two sentences: why can't the relay node read this conversation?");
await page.click("#send");
await page.waitForFunction(() => (window.__rc?.results.length ?? 0) + (window.__rc?.errors.length ?? 0) > 0, null, { timeout: 300000 });
const r = await page.evaluate(() => ({ results: window.__rc.results, errors: window.__rc.errors }));
console.log(JSON.stringify({ errors: r.errors, ttftMs: r.results.at(-1)?.ttftMs, costMsats: r.results.at(-1)?.costMsats, receiptSigOk: r.results.at(-1)?.receiptSigOk }));
// open the message's verification details
await page.locator("button", { hasText: "details" }).last().click().catch(() => {});
// never show any part of the key in a screenshot
await page.evaluate(() => {
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (/sk-[0-9a-zA-Z]/.test(n.textContent ?? "")) n.textContent = (n.textContent ?? "").replace(/sk-[^\s]+/g, "sk-••••••");
  }
});
await page.waitForTimeout(800);
const html = await page.content();
const leaked = html.includes(key) || html.includes(key.slice(3, 8)) || html.includes(key.slice(-8));
console.log("key visible in page:", leaked);
if (!leaked) {
  await page.screenshot({ path: `${process.env.OUT}/pwa-full.png`, fullPage: true });
  await page.screenshot({ path: `${process.env.OUT}/pwa-viewport.png` });
}
await browser.close();

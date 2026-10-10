// The automatic update works without a hard refresh: build A, open it (the
// service worker takes control), build B over it, make the page check, and
// expect a reload into B with the "Updated to vB" notice.
//   node scripts/update-test.mjs
import { execSync } from "node:child_process";
import { chromium } from "playwright";
import { PREFIX, serveDist } from "./serve-dist.mjs";

const build = (v) => execSync("npx vite build", { env: { ...process.env, APP_VERSION: v }, stdio: "ignore" });
build("0.0.1-test");
const server = await serveDist(4177);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:4177${PREFIX}`);
await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 30_000 });
const before = await page.textContent("footer");
build("0.0.2-test");
const reloaded = page.waitForEvent("framenavigated", { timeout: 60_000 });
await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await reloaded;
await page.waitForSelector(".toast", { timeout: 30_000 });
const toast = await page.textContent(".toast");
const after = await page.textContent("footer");
console.log(JSON.stringify({ before: before?.slice(0, 20), after: after?.slice(0, 20), toast }));
const ok = /0\.0\.1-test/.test(before ?? "") && /0\.0\.2-test/.test(after ?? "") && /Updated to v0\.0\.2-test/.test(toast ?? "");
await browser.close();
server.close();
execSync("npx vite build", { stdio: "ignore" }); // restore the real build
console.log(ok ? "ok   automatic update to the new version, with notice" : "FAIL automatic update");
process.exit(ok ? 0 : 1);

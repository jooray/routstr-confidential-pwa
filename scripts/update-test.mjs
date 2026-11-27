// The automatic update works without a hard refresh: build A, open it (the
// service worker takes control), build B over it, make the page check, and
// expect a reload into B with the "Updated to vB" notice and the conversation
// still on the page. Then build B again (same version, other files: the build
// time differs) and expect a second reload, found through version.json's
// assets_sha256.
//   node scripts/update-test.mjs
import { execSync } from "node:child_process";
import { chromium } from "playwright";
import { PREFIX, serveDist } from "./serve-dist.mjs";

const build = (v) => execSync("npx vite build", { env: { ...process.env, APP_VERSION: v, VITE_TEST_HOOKS: "1" }, stdio: "ignore" });
let failed = 0;
const check = (n, c, x = "") => {
  console.log(`${c ? "ok  " : "FAIL"} ${n} ${c ? "" : x}`);
  if (!c) failed++;
};
const buildId = (page) => page.$eval("header .muted[title^='build ']", (e) => e.title);

build("0.0.1-test");
const server = await serveDist(4177);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:4177${PREFIX}?prewarm=0`);
await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 30_000 });
const before = await page.textContent("footer");
// A conversation: it lives only in memory and must survive the update reload.
await page.evaluate(() => {
  window.__rc.addTurn("user", "What is 2 + 2?");
  window.__rc.addTurn("assistant", "**4**");
});

build("0.0.2-test");
let reloaded = page.waitForEvent("framenavigated", { timeout: 60_000 });
await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await reloaded;
await page.waitForSelector(".toast", { timeout: 30_000 });
const toast = await page.textContent(".toast");
const after = await page.textContent("footer");
console.log(JSON.stringify({ before: before?.slice(0, 20), after: after?.slice(0, 20), toast }));
check("automatic update to the new version, with notice", /0\.0\.1-test/.test(before ?? "") && /0\.0\.2-test/.test(after ?? "") && /Updated to v0\.0\.2-test/.test(toast ?? ""));
const turns = await page.evaluate(() => window.__rc.turns());
check("the conversation survives the update reload", JSON.stringify(turns) === JSON.stringify([{ role: "user", content: "What is 2 + 2?" }, { role: "assistant", content: "**4**" }]), JSON.stringify(turns));
check("the restored answer is rendered", (await page.$$eval("#messages .msg.assistant .md strong", (l) => l.map((x) => x.textContent))).includes("4"));
check("the conversation is not kept after it was restored", (await page.evaluate(() => sessionStorage.getItem("rc:reload-turns"))) === null);

// Same version, other files: only assets_sha256 tells them apart.
const idBefore = await buildId(page);
build("0.0.2-test");
reloaded = page.waitForEvent("framenavigated", { timeout: 60_000 });
await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await reloaded;
await page.waitForFunction(() => /latest build/.test(document.querySelector(".toast")?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => {});
const idAfter = await buildId(page);
const toast2 = await page.textContent(".toast");
check("a deploy without a version bump reaches the open tab", idBefore !== idAfter && /latest build of v0\.0\.2-test/.test(toast2 ?? ""), JSON.stringify({ idBefore, idAfter, toast2 }));

// Cache Storage is the origin's: an entry another site on it put into a cache
// of its own is never served by this app's worker.
const foreign = await page.evaluate(async () => {
  const url = new URL("assets/not-ours.js", location.href).href;
  const c = await caches.open("another-site");
  await c.put(url, new Response("planted", { headers: { "content-type": "text/javascript" } }));
  const r = await fetch(url);
  const text = await r.text();
  await caches.delete("another-site");
  return { status: r.status, text };
});
check("the worker answers only from its own cache", foreign.text !== "planted", JSON.stringify(foreign));

await browser.close();
server.close();
execSync("npx vite build", { env: { ...process.env, VITE_TEST_HOOKS: "1" }, stdio: "ignore" }); // restore the real version (a test build, as the other tests need)
process.exit(failed ? 1 : 0);

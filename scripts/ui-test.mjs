// Model combobox + timing waterfall, in a real browser.  node scripts/ui-test.mjs [shot-dir]
import { chromium } from "playwright";
import { PREFIX, serveDist } from "./serve-dist.mjs";
const dir = process.argv[2];
const server = await serveDist(4176);
const browser = await chromium.launch();
let failed = 0;
const check = (n, c, x = "") => { console.log(`${c ? "ok  " : "FAIL"} ${n} ${c ? "" : x}`); if (!c) failed++; };
for (const vp of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  const page = await browser.newPage({ viewport: vp });
  await page.goto(`http://127.0.0.1:4176${PREFIX}?prewarm=0`);
  await page.waitForFunction(() => (document.querySelector("#model")?.value ?? "").length > 0, null, { timeout: 30000 });
  const tag = `${vp.width}px`;
  check(`${tag} one input, no select`, (await page.$$("select#model, #model-search")).length === 0);
  check(`${tag} default shown`, /DeepSeek V4 Flash 0731/i.test(await page.inputValue("#model")), await page.inputValue("#model"));
  await page.click("#model");
  const all = await page.$$eval("#model-list li", (l) => l.length);
  await page.keyboard.type("qwen flash");
  const filtered = await page.$$eval("#model-list li", (l) => l.map((x) => x.firstChild.textContent));
  check(`${tag} filters as typed (${all} → ${filtered.length})`, filtered.length > 0 && filtered.length < all && filtered.every((n) => /qwen/i.test(n) && /flash/i.test(n)), JSON.stringify(filtered));
  if (dir) await page.screenshot({ path: `${dir}/combo-${tag}.png` });
  await page.keyboard.press("Enter");
  const picked = await page.inputValue("#model");
  check(`${tag} Enter picks first match`, picked === filtered[0], picked);
  check(`${tag} list closed`, await page.$eval("#model-list", (l) => l.hidden));
  await page.click("#model");
  await page.keyboard.type("zzz");
  await page.keyboard.press("Escape");
  check(`${tag} Escape restores`, (await page.inputValue("#model")) === picked);
  check(`${tag} no horizontal overflow`, !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
  // waterfall with a warm-request shape (from the screenshot's numbers)
  const spans = [
    { name: "setup (node checks credential, reserves)", lane: "node", startMs: -21500, endMs: -21180 },
    { name: "2PC preprocessing + key share", lane: "2pc", startMs: -21180, endMs: -650 },
    { name: "proof channel setup", lane: "proofs", startMs: -21100, endMs: -17000 },
    { name: "TLS handshake with provider", lane: "tls", startMs: 0, endMs: 1938 },
    { name: "2PC phase A (handshake keys)", lane: "2pc", startMs: 150, endMs: 890 },
    { name: "2PC phase B (application keys)", lane: "2pc", startMs: 1000, endMs: 1876 },
    { name: "π_NK (node's record is the template)", lane: "proofs", startMs: 1938, endMs: 2285 },
    { name: "credential record (node)", lane: "node", startMs: 2285, endMs: 2361 },
    { name: "provider: time to first byte", lane: "provider", startMs: 2362, endMs: 3592 },
    { name: "π_C2S (pinned suffix)", lane: "proofs", startMs: 2400, endMs: 2600 },
    { name: "response streaming", lane: "provider", startMs: 3592, endMs: 29500 },
    { name: "settlement (usage proof, receipt)", lane: "node", startMs: 29500, endMs: 30407 },
  ];
  for (const numbers of [false, true]) {
    await page.evaluate(({ spans, numbers }) => {
      document.getElementById("wf-test")?.remove();
      const box = document.createElement("div");
      box.id = "wf-test";
      box.className = "card timing";
      box.style.cssText = "position:fixed;left:8px;right:8px;top:8px;z-index:99;max-width:640px;background:var(--panel);padding:12px";
      box.append(window.__rc.waterfall(spans, { ttftMs: 3592, numbers }));
      document.body.append(box);
    }, { spans, numbers });
    const bars = await page.$$eval("#wf-test .wf-bar", (b) => b.length);
    check(`${tag} waterfall bars (numbers=${numbers})`, bars === spans.length);
    const sentX = await page.$eval("#wf-test .wf-marker.sent", (m) => m.getBoundingClientRect().x);
    const preEnd = await page.$eval("#wf-test .wf-bar.lane-2pc", (b) => b.getBoundingClientRect().right);
    check(`${tag} pre-arm left of the request line`, preEnd <= sentX + 1, `${preEnd} vs ${sentX}`);
    if (dir) await (await page.$("#wf-test")).screenshot({ path: `${dir}/wf-${tag}-${numbers ? "numbers" : "chart"}.png` });
  }
  await page.close();
}
await browser.close(); server.close();
process.exit(failed ? 1 : 0);

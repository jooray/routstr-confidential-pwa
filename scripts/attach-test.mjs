// Chat image input: the attach button follows the node's input_modalities, an
// attached image is downscaled to JPEG and shown, and a too-small image is
// refused. Against the configured node, nothing is sent.
//   node scripts/attach-test.mjs [image]      (build first: npm run build)
import { chromium } from "playwright";
import { PREFIX, serveDist } from "./serve-dist.mjs";

const PORT = 4176;
const server = await serveDist(PORT);
const browser = await chromium.launch();
let failed = false;
const say = (ok, msg) => {
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
};
// A 2000x1200 PNG and a 32x32 one, drawn in the page.
async function png(page, w, hgt) {
  const b64 = await page.evaluate(([w, hgt]) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = hgt;
    const x = c.getContext("2d");
    x.fillStyle = "#3a7";
    x.fillRect(0, 0, w, hgt);
    return c.toDataURL("image/png").split(",")[1];
  }, [w, hgt]);
  return { name: `t${w}.png`, mimeType: "image/png", buffer: Buffer.from(b64, "base64") };
}
async function open(model) {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  page.on("pageerror", (e) => say(false, `pageerror ${e.message}`));
  await page.addInitScript((m) => localStorage.setItem("rc:model", JSON.stringify(m)), model);
  await page.goto(`http://127.0.0.1:${PORT}${PREFIX}?prewarm=0`);
  await page.waitForFunction(() => /offer (verified|rejected)/.test(document.getElementById("offer-pill")?.textContent ?? ""), null, { timeout: 30_000 });
  await page.waitForTimeout(1500); // the model list (input_modalities)
  return page;
}
try {
  const text = await open("deepseek-v4-flash");
  say(await text.$eval("#attach", (b) => b.disabled), "attach is off for a text-only model");
  await text.close();

  const page = await open("mistral-small-3-2-24b-instruct");
  say(!(await page.$eval("#attach", (b) => b.disabled)), "attach is on for a vision model");
  await page.setInputFiles("#attach-input", [await png(page, 2000, 1200)]);
  await page.waitForSelector(".attachment img");
  say(await page.isVisible("#attachments"), "strip shown with an attachment");
  const src = await page.$eval(".attachment img", (i) => i.src);
  const dims = await page.$eval(".attachment img", (i) => [i.naturalWidth, i.naturalHeight]);
  say(src.startsWith("data:image/jpeg;base64,") && dims[0] === 1568 && dims[1] === 941, `downscaled to JPEG ${dims.join("x")}, ${Math.round(src.length / 1024)} KB`);
  await page.setInputFiles("#attach-input", [await png(page, 32, 32)]);
  await page.waitForTimeout(300);
  const toast = await page.textContent(".toast");
  say((await page.$$(".attachment")).length === 1 && /at least 64x64/.test(toast ?? ""), `32x32 refused: ${toast}`);
  say(/≈/.test((await page.textContent("#estimate")) ?? ""), "estimate shown");
  say(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), "no horizontal overflow at 390px");
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
  await page.click(".attachment button");
  say((await page.$$(".attachment")).length === 0 && !(await page.isVisible("#attachments")), "removed, and the strip is hidden");
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);

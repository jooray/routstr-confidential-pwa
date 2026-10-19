// Image mode against a fake node, in a real browser: the controls come from
// the signed offer's image block, typing an image prompt arms nothing, and
// Generate opens one cold session whose setup is an image setup (no armed
// flag, no max_tokens).  node scripts/image-ui-test.mjs
import { chromium } from "playwright";
import { PREFIX, serveDist } from "./serve-dist.mjs";

async function noble() {
  try {
    return [await import("@noble/curves/secp256k1"), await import("@noble/hashes/sha2")];
  } catch {
    // The library linked from a local checkout keeps its own node_modules.
    const base = new URL("../node_modules/@routstr/confidential-web/node_modules/@noble/", import.meta.url).href;
    return [await import(`${base}curves/secp256k1.js`), await import(`${base}hashes/sha2.js`)];
  }
}
const [{ schnorr }, { sha256 }] = await noble();

const NODE = "https://fake-node.test";
const sk = new Uint8Array(32).fill(7);
const pubkey = Buffer.from(schnorr.getPublicKey(sk)).toString("hex");
const fixed = [["return_binary", false], ["enhance_prompt", false], ["enable_web_search", false], ["style_references", []]];
const body = {
  v: 2,
  min_v: 2,
  max_v: 2,
  upstream_host: "api.venice.ai",
  notary_pubkey: pubkey,
  max_tokens_cap: 32768,
  key_length: 63,
  head_template:
    "POST /api/v1/chat/completions HTTP/1.1\r\nHost: api.venice.ai\r\nAuthorization: Bearer {KEY:63}\r\nContent-Type: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\nContent-Length: {LEN}\r\n\r\n",
  suffix_keys: ["model", "max_tokens"],
  price_list: { "deepseek-v4-flash-0731": { in: 160, cached_in: 34, out: 320 } },
  abandon_fee_msat: 2000,
  capabilities: ["chat", "images"],
  images: {
    head_template:
      "POST /api/v1/image/generate HTTP/1.1\r\nHost: api.venice.ai\r\nAuthorization: Bearer {KEY:63}\r\nContent-Type: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\nContent-Length: {LEN}\r\n\r\n",
    response_shape: "venice",
    response_idle_s: 300,
    count_key: "variants",
    fixed_pins: fixed,
    param_space: { resolution: ["1K", "2K", "4K"], quality: ["low", "medium", "high"], format: ["webp"] },
    max_count: 4,
    price_list: {
      "z-image-turbo": [{ id: "webp", pins: [["format", "webp"]], msat_per_image: 12164 }],
      "qwen-image-2-1-turbo": [{ id: "webp", pins: [["format", "webp"]], msat_per_image: 24329 }],
      "nano-banana-pro": [
        { id: "1K-webp", pins: [["resolution", "1K"], ["format", "webp"]], msat_per_image: 218000 },
        { id: "2K-webp", pins: [["resolution", "2K"], ["format", "webp"]], msat_per_image: 290000 },
      ],
    },
  },
};
const payload = JSON.stringify(body);
const sig = Buffer.from(schnorr.sign(sha256(new TextEncoder().encode(payload)), sk)).toString("hex");
const offer = { ...body, sig, sig_payload: payload };

const server = await serveDist(4177);
const browser = await chromium.launch();
let failed = 0;
const check = (n, c, x = "") => {
  console.log(`${c ? "ok  " : "FAIL"} ${n} ${c ? "" : x}`);
  if (!c) failed++;
};

for (const vp of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  const tag = `${vp.width}px`;
  const page = await browser.newPage({ viewport: vp });
  const sockets = [];
  const sent = [];
  let holdImageMs = 0;
  await page.routeWebSocket(/fake-node\.test/, (ws) => {
    sockets.push(ws.url());
    ws.onMessage((m) => {
      if (typeof m !== "string") return;
      const msg = JSON.parse(m);
      sent.push(msg);
      if (msg.type === "setup") {
        const stop = () => ws.send(JSON.stringify({ type: "error", reason: "test node stops here", status: 503 }));
        if (msg.kind === "images" && holdImageMs) setTimeout(stop, holdImageMs);
        else stop();
      }
    });
  });
  await page.route(`${NODE}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (v, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(v) });
    if (path === "/v1/confidential/offer") return json(offer);
    if (path === "/v1/models") return json({ data: [] });
    if (path === "/v1/balance/info") return json({ balance: 5_000_000, reserved: 0 });
    return json({ error: "not here" }, 404);
  });
  await page.addInitScript(
    ({ node, pubkey }) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("rc:settings", JSON.stringify({ node, pubkey, trustedHost: "api.venice.ai" }));
      localStorage.setItem("rc:credential", JSON.stringify("sk-test"));
      localStorage.setItem("rc:remember", "true");
    },
    { node: NODE, pubkey },
  );
  await page.goto(`http://127.0.0.1:4177${PREFIX}`);
  await page.waitForFunction(() => document.querySelector("#offer-pill")?.textContent === "offer verified", null, { timeout: 30000 });

  await page.click("#mode-image");
  await page.waitForFunction(() => (document.querySelector("#img-model")?.options.length ?? 0) > 0);
  check(`${tag} image controls shown, chat controls hidden`, await page.evaluate(() => !document.getElementById("image-controls").hidden && document.getElementById("chat-controls").hidden));
  check(`${tag} default image model`, (await page.inputValue("#img-model")) === "qwen-image-2-1-turbo", await page.inputValue("#img-model"));
  const est = await page.textContent("#img-estimate");
  check(`${tag} estimate: price and setup data`, /24\.3\d* sat|24 sat/.test(est) && /26 MB/.test(est), est);
  check(`${tag} one variant: no resolution choice`, await page.$eval("#img-variant-label", (l) => l.hidden));
  await page.selectOption("#img-model", "nano-banana-pro");
  check(`${tag} tiers: resolution choice`, !(await page.$eval("#img-variant-label", (l) => l.hidden)));
  check(`${tag} count up to max_count`, (await page.$$eval("#img-count option", (o) => o.length)) === 4);
  await page.selectOption("#img-variant", "2K-webp");
  await page.selectOption("#img-count", "2");

  await page.click("#prompt");
  await page.keyboard.type("a lighthouse at dawn");
  await page.waitForTimeout(500);
  check(`${tag} typing an image prompt opens no session (no pre-arm)`, sockets.length === 0, JSON.stringify(sockets));

  await page.click("#send");
  await page.waitForFunction(() => document.querySelector(".image-pending.error, .image-pending .cross"), null, { timeout: 30000 });
  const setup = sent.find((m) => m.type === "setup");
  check(`${tag} one cold session`, sockets.length >= 1 && sockets.every((u) => u.includes("/v1/confidential/ws")), JSON.stringify(sockets));
  check(
    `${tag} image setup: kind, variant, count; no armed, no max_tokens, no suffix`,
    setup && setup.kind === "images" && setup.model === "nano-banana-pro" && setup.variant === "2K-webp" && setup.count === 2 &&
      !("armed" in setup) && !("max_tokens" in setup) && !("suffix" in setup) && setup.offer_sig === sig && setup.abandon_fee_msat === 2000,
    JSON.stringify(setup && { ...setup, auth: "…" }),
  );
  check(`${tag} the prompt is not in the setup`, !JSON.stringify(setup ?? {}).includes("lighthouse"));
  check(`${tag} error shown`, /test node stops here|rejected/i.test(await page.textContent(".image-pending")));
  check(`${tag} no horizontal overflow`, !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
  if (vp.width === 1280) {
    // Chat activity while an image session runs must not start a chat arm
    // alongside it; once the image is done the pool may arm again.
    await page.evaluate(() => {
      const c = window.__rc.client();
      c.pricing = async () => Object.keys(c.offerCache?.offer.price_list ?? {}).map((id) => ({ id, reservationMsat: 1 }));
    });
    holdImageMs = 2500;
    const before = sent.length;
    await page.fill("#prompt", "a fox in the snow");
    await page.click("#send");
    await page.waitForFunction(() => document.querySelectorAll(".image-pending:not(.error)").length > 0);
    await page.evaluate(() => window.__rc.client().prewarmer.activity());
    await page.waitForTimeout(1500);
    const during = sent.slice(before).filter((m) => m.type === "setup");
    check("image session: chat activity arms nothing alongside it", during.length === 1 && during[0].kind === "images", JSON.stringify(during.map((m) => m.kind ?? (m.armed ? "chat-armed" : "chat"))));
    await page.waitForFunction(() => document.querySelectorAll(".image-pending:not(.error)").length === 0, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    const after = sent.slice(before).filter((m) => m.type === "setup" && m.kind !== "images");
    check("after the image, the chat pool arms again (the gate was what held it)", after.length >= 1, JSON.stringify(after.length));
    holdImageMs = 0;
    // A noisy 1792×1008 lossless WebP, as large as a provider image: the
    // re-encode keeps it at most 1200 px wide and much smaller.
    const r = await page.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 1792;
      c.height = 1008;
      const ctx = c.getContext("2d");
      const g = ctx.createLinearGradient(0, 0, 1792, 1008);
      g.addColorStop(0, "#c84");
      g.addColorStop(1, "#246");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 1792, 1008);
      for (let i = 0; i < 4000; i++) {
        ctx.fillStyle = `hsl(${i % 360} 60% ${30 + (i % 40)}%)`;
        ctx.fillRect((i * 97) % 1792, (i * 53) % 1008, 6 + (i % 9), 6 + (i % 7));
      }
      const src = await new Promise((res) => c.toBlob(res, "image/webp", 1));
      const out = await window.__rc.reencode(src);
      const bmp = await createImageBitmap(out);
      // The gallery shows stored images through blob: URLs, which the page's
      // CSP must allow.
      const img = document.createElement("img");
      const shown = await new Promise((res) => {
        img.onload = () => res(img.naturalWidth);
        img.onerror = () => res(0);
        img.src = URL.createObjectURL(out);
        document.body.append(img);
      });
      img.remove();
      // A tiny image is re-encoded too (never the provider's own file, which
      // could carry metadata), and an undecodable one is not kept.
      const tiny = document.createElement("canvas");
      tiny.width = 8;
      tiny.height = 8;
      const tinySrc = await new Promise((res) => tiny.toBlob(res, "image/png"));
      const tinyOut = await window.__rc.reencode(tinySrc);
      const junk = await window.__rc.reencode(new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }));
      return {
        inSize: src.size, outSize: out.size, type: out.type, width: bmp.width, height: bmp.height, shown,
        tinyReencoded: tinyOut !== tinySrc && tinyOut?.type === "image/webp", junkDropped: junk === undefined,
      };
    });
    check("re-encode: smaller, at most 1200 px, WebP", r.outSize < r.inSize && r.width === 1200 && r.height === 675 && r.type === "image/webp", JSON.stringify(r));
    check("re-encode: always redrawn, an undecodable image dropped", r.tinyReencoded && r.junkDropped, JSON.stringify(r));
    check("a stored image renders inline (CSP allows blob:)", r.shown === 1200, JSON.stringify(r));
  }
  await page.close();
}

await browser.close();
server.close();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}

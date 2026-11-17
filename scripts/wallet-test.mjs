// Wallet handling against two fake nodes, in a real browser (nothing leaves
// the machine):
//  - a key is kept per node URL: switching nodes never sends the old key to
//    the new node, and switching back restores it;
//  - every Lightning invoice is polled on its own (a second one does not stop
//    the first), and a paid invoice whose key differs from the key in use is
//    offered, not swapped in;
//  - Withdraw waits until the node shows no reservation, then refunds;
//  - an automatic update reload keeps the in-memory key, the withdrawn token
//    and the pending invoices of this tab;
//  - a malformed image block in the signed offer turns images off, chat works;
//  - a request body above the relay's limit is refused before any session;
//  - a chat request shows its stages in plain words, and the 2PC download as
//    a bar (scripted events); its failure is one plain sentence with the raw
//    text under "details"; every library error code has a plain sentence;
//  - a deposit outcome the library flags is shown as a notice.
//   node scripts/wallet-test.mjs      (build first: npm run build)
import { chromium } from "playwright";
import { PREFIX, serveDist } from "./serve-dist.mjs";

async function noble() {
  try {
    return [await import("@noble/curves/secp256k1"), await import("@noble/hashes/sha2")];
  } catch {
    const base = new URL("../node_modules/@routstr/confidential-web/node_modules/@noble/", import.meta.url).href;
    return [await import(`${base}curves/secp256k1.js`), await import(`${base}hashes/sha2.js`)];
  }
}
const [{ schnorr }, { sha256 }] = await noble();

const NODE_A = "https://fake-node.test";
const NODE_B = "https://other-node.test";
const KEY_A = "sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_NEW = "sk-nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn";
const sk = new Uint8Array(32).fill(9);
const pubkey = Buffer.from(schnorr.getPublicKey(sk)).toString("hex");
const head = (path) =>
  `POST /api/v1/${path} HTTP/1.1\r\nHost: api.venice.ai\r\nAuthorization: Bearer {KEY:63}\r\nContent-Type: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\nContent-Length: {LEN}\r\n\r\n`;
const body = {
  v: 3,
  twopc: "split-public-1",
  http: ["2", "1.1"],
  h2: { probe_path: "/api/v1/models", idle_secs: 300, max_requests: 100, max_lifetime_s: 3600, kinds: ["chat", "images"] },
  connection_deposit_msat: 2000,
  idle_timeout_s: 120,
  upstream_host: "api.venice.ai",
  notary_pubkey: pubkey,
  max_tokens_cap: 32768,
  key_length: 63,
  head_template: head("chat/completions"),
  suffix_keys: ["model", "max_tokens", "stream", "stream_options"],
  chat: { cap_keys: ["max_tokens"], fixed_pins: [["stream", true], ["stream_options", { include_usage: true }]] },
  price_list: { "deepseek-v4-flash-0731": { in: 160, cached_in: 34, out: 320 } },
  abandon_fee_msat: 2000,
  capabilities: ["chat", "images"],
  // Malformed: a variant pin key outside the policy.
  images: {
    head_template: head("image/generate"),
    response_shape: "venice",
    response_idle_s: 300,
    count_key: "variants",
    fixed_pins: [["return_binary", false]],
    param_space: { format: ["webp"] },
    max_count: 4,
    price_list: { "z-image-turbo": [{ id: "x", pins: [["brand_new_key", "x"]], msat_per_image: 1000 }] },
  },
};
const payload = JSON.stringify(body);
const sig = Buffer.from(schnorr.sign(sha256(new TextEncoder().encode(payload)), sk)).toString("hex");
const offer = { ...body, sig, sig_payload: payload };

const server = await serveDist(4178);
const browser = await chromium.launch();
let failed = 0;
const check = (n, c, x = "") => {
  console.log(`${c ? "ok  " : "FAIL"} ${n} ${c ? "" : x}`);
  if (!c) failed++;
};

const context = await browser.newContext({ serviceWorkers: "block" });
const page = await context.newPage();
page.on("dialog", (d) => d.accept());
const sockets = [];
/** While set, the fake node answers nothing (the request waits), and the socket is kept here. */
let hold = false;
let heldWs;
await page.routeWebSocket(/(fake|other)-node\.test/, (ws) => {
  sockets.push(ws.url());
  ws.onMessage(() => {
    if (hold) {
      heldWs = ws;
      return;
    }
    ws.send(JSON.stringify({ type: "error", reason: "test node stops here", status: 503 }));
  });
});
/** Every Authorization header each node received. */
const auth = { [NODE_A]: [], [NODE_B]: [] };
const statusPolls = {};
const paid = {};
let reservedPolls = 0;
let refunds = 0;
let invoiceNo = 0;
for (const node of [NODE_A, NODE_B]) {
  await page.route(`${node}/**`, (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const a = req.headers()["authorization"];
    if (a) auth[node].push(a);
    const json = (v, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(v) });
    const p = url.pathname;
    if (p === "/v1/confidential/offer") return json(offer);
    if (p === "/v1/models") return json({ data: [] });
    if (p === "/v1/balance/info") {
      // While a withdraw waits, the first two reads still show a reservation.
      const waiting = refunds === 0 && reservedPolls > 0 && reservedPolls < 3;
      if (reservedPolls > 0) reservedPolls++;
      return json({ api_key: "x", balance: 5_000_000, reserved: waiting ? 3000 : 0 });
    }
    if (p === "/lightning/invoice") {
      invoiceNo++;
      return json({ invoice_id: `inv${invoiceNo}`, bolt11: `lnbc10n1test${invoiceNo}`, amount_sats: 10, expires_at: Math.floor(Date.now() / 1000) + 600, payment_hash: "00" });
    }
    const m = p.match(/^\/lightning\/invoice\/([^/]+)\/status$/);
    if (m) {
      statusPolls[m[1]] = (statusPolls[m[1]] ?? 0) + 1;
      return json(paid[m[1]] ? { status: "paid", api_key: paid[m[1]], amount_sats: 10 } : { status: "pending", amount_sats: 10 });
    }
    if (p === "/v1/balance/refund") {
      refunds++;
      return json({ token: "cashuBtesttoken" });
    }
    return json({ error: `not here: ${p}` }, 404);
  });
}
let fakeVersion;
await page.route("**/version.json*", (route) =>
  fakeVersion ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: fakeVersion }) }) : route.continue(),
);
await page.addInitScript(
  ({ node, pubkey, key }) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("rc:settings", JSON.stringify({ node, pubkey, trustedHost: "api.venice.ai" }));
    // The single key of earlier versions: migrated to node A's key.
    localStorage.setItem("rc:credential", JSON.stringify(key));
    localStorage.setItem("rc:remember", "true");
    localStorage.setItem("rc:prewarm", "false");
  },
  { node: NODE_A, pubkey, key: KEY_A },
);
await page.goto(`http://127.0.0.1:4178${PREFIX}`);
await page.waitForFunction(() => document.querySelector("#offer-pill")?.textContent === "offer verified", null, { timeout: 30000 });

// Malformed image block: chat is set up, images are off.
await page.waitForFunction(() => (document.querySelector("#side")?.textContent ?? "").includes("Mints this node accepts"), null, { timeout: 10000 }).catch(() => {});
check("malformed image block: chat setup completes (mint fees line shown)", (await page.textContent("#side")).includes("Mints this node accepts"));
await page.click("#mode-image");
check("malformed image block: images off, said so", /malformed/.test(await page.textContent("#img-estimate")), await page.textContent("#img-estimate"));
await page.click("#mode-chat");

// Legacy key migrated, per node.
const stored = await page.evaluate(() => [localStorage.getItem("rc:credential"), localStorage.getItem("rc:credentials")]);
check("legacy key migrated to the per-node store", stored[0] === null && JSON.parse(stored[1] ?? "{}")["https://fake-node.test"] !== undefined);
check("node A received its key", auth[NODE_A].some((a) => a === `Bearer ${KEY_A}`));

// Switch to node B: its requests carry no key at all.
await page.fill("#set-node", NODE_B);
await page.click("text=Apply");
await page.waitForFunction(() => document.querySelector("#offer-pill")?.textContent === "offer verified", null, { timeout: 30000 });
await page.waitForTimeout(500);
check("node B never received node A's key", !auth[NODE_B].some((a) => a.includes(KEY_A)), JSON.stringify(auth[NODE_B]));
check("node B: wallet shows no key", (await page.textContent("#side")).includes("No key for this node"));
// Back to node A: its key is used again.
const before = auth[NODE_A].length;
await page.fill("#set-node", NODE_A);
await page.click("text=Apply");
await page.waitForFunction(() => document.querySelector("#offer-pill")?.textContent === "offer verified", null, { timeout: 30000 });
await page.waitForTimeout(500);
check("back on node A: its key again", auth[NODE_A].slice(before).some((a) => a === `Bearer ${KEY_A}`));

// Two invoices: both polled; the first, paid with a different key, is offered.
await page.fill("#ln-amount", "10");
await page.click("button:has-text('Lightning')");
await page.waitForFunction(() => document.querySelectorAll("#invoice .invoice").length === 1);
await page.click("button:has-text('Lightning')");
await page.waitForFunction(() => document.querySelectorAll("#invoice .invoice").length === 2);
await page.waitForTimeout(3500);
check("a second invoice does not stop the first one's poll", (statusPolls.inv1 ?? 0) >= 1 && (statusPolls.inv2 ?? 0) >= 1, JSON.stringify(statusPolls));
check("pending invoices kept in sessionStorage", (await page.evaluate(() => JSON.parse(sessionStorage.getItem("rc:invoices") ?? "[]").length)) === 2);

// Automatic update reload: a key kept only in memory, a withdrawn token and the invoices survive.
await page.click("summary:has-text('Your key')");
await page.uncheck("text=Remember on this device");
check("unticked: no key in local storage", (await page.evaluate(() => localStorage.getItem("rc:credentials"))) === null);
// Withdraw: waits for the reservation to go, then refunds.
await page.click("summary:has-text('Withdraw')");
reservedPolls = 1;
await page.click("#refund-btn");
await page.waitForFunction(() => (document.querySelector("#refund-token")?.textContent ?? "").includes("Withdrawn"), null, { timeout: 15000 });
check("withdraw waited for reserved = 0 before refunding", reservedPolls >= 3 && refunds === 1, JSON.stringify({ reservedPolls, refunds }));
check("withdrawn token shown", (await page.inputValue("#refund-token textarea")) === "cashuBtesttoken");

fakeVersion = "9.9.9";
const reloaded = page.waitForEvent("load", { timeout: 15000 });
await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await reloaded;
await page.waitForFunction(() => document.querySelector("#offer-pill")?.textContent === "offer verified", null, { timeout: 30000 });
await page.waitForTimeout(500);
const after = await page.evaluate(() => ({
  stash: sessionStorage.getItem("rc:reload-stash"),
  token: document.querySelector("#refund-token textarea")?.value,
  invoices: document.querySelectorAll("#invoice .invoice").length,
  hasKey: (document.querySelector("#side")?.textContent ?? "").includes("Your key"),
}));
check("after the update reload: key restored", after.hasKey, JSON.stringify(after));
check("after the update reload: withdrawn token restored", after.token === "cashuBtesttoken", JSON.stringify(after));
check("after the update reload: invoices still shown", after.invoices === 2, JSON.stringify(after));
check("after the update reload: stash removed", after.stash === null);

// The first invoice is paid with a different key: offered, not swapped in.
paid.inv1 = KEY_NEW;
await page.waitForFunction(() => (document.querySelector("#key-offers")?.textContent ?? "").includes("gave a new key"), null, { timeout: 10000 });
const n0 = auth[NODE_A].length;
await page.waitForTimeout(500);
check("paid invoice with another key: offered, the current key stays", !auth[NODE_A].slice(n0).some((a) => a.includes(KEY_NEW)));
await page.click("button:has-text('Use the new key')");
await page.waitForTimeout(800);
check("after choosing: the new key is used", auth[NODE_A].slice(n0).some((a) => a === `Bearer ${KEY_NEW}`));

// Body above the relay limit: refused before any session, with a clear message.
const s0 = sockets.length;
await page.evaluate(() => {
  const ta = document.getElementById("prompt");
  ta.value = "x".repeat(8 * 1024 * 1024);
});
await page.click("#send");
await page.waitForTimeout(800);
const toastText = (await page.textContent(".toast")) ?? "";
check("too-large body: refused with what to do", /too large to send/.test(toastText) && /new chat/.test(toastText), toastText.slice(0, 200));
check("too-large body: no session opened", sockets.length === s0);

// Stages of a chat request, in plain words, and the 2PC download as a bar.
hold = true;
await page.evaluate(() => {
  document.getElementById("prompt").value = "hello";
});
await page.click("#send");
const meta = () => page.textContent("#messages .msg.assistant:last-child .meta");
const bar = () => page.$eval("#messages .msg.assistant:last-child .meta progress", (b) => ({ hidden: b.hidden, value: b.value, max: b.max })).catch(() => undefined);
await page.waitForFunction(() => /confidential/i.test(document.querySelector("#messages .msg.assistant:last-child .meta")?.textContent ?? ""), null, { timeout: 10000 }).catch(() => {});
check("chat: a starting stage is shown", /confidential/i.test((await meta()) ?? ""), await meta());
check("chat: no bar before the download starts", (await bar())?.hidden === true, JSON.stringify(await bar()));
await page.evaluate(() => window.__rc.event({ ev: "ready", kind: "chat", http: "2", armed: false }));
check("chat: the setup stage in plain words", /Setting up a secure connection/.test((await meta()) ?? ""), await meta());
await page.evaluate(() => window.__rc.event({ ev: "twopc_progress", kind: "chat", received: 8_200_000, expected: 16_400_000 }));
const b1 = await bar();
check("chat: the 2PC download as a bar with megabytes", b1?.hidden === false && b1.value === 8_200_000 && b1.max === 16_400_000 && /8\.2 of 16\.4 MB/.test((await meta()) ?? ""), JSON.stringify({ b1, meta: await meta() }));
await page.evaluate(() => window.__rc.event({ ev: "twopc_progress", kind: "images", received: 1, expected: 16_400_000 }));
check("chat: an image connection's progress does not move the chat bar", (await bar())?.value === 8_200_000);
await page.evaluate(() => window.__rc.event({ ev: "armed", kind: "chat", http: "2", arm_ms: 1 }));
check("chat: after the download the bar goes and the next stage shows", (await bar())?.hidden === true && /Connecting to the provider/.test((await meta()) ?? ""), await meta());
await page.evaluate(() => window.__rc.event({ ev: "pi_win_ok", kind: "chat", first_seq: 1, count: 1 }));
check("chat: the proof stage", /Waiting for the first words/.test((await meta()) ?? ""), await meta());
// The node then refuses: one plain sentence, the raw text under "details".
heldWs?.send(JSON.stringify({ type: "error", reason: "test node stops here", status: 503 }));
hold = false;
await page.waitForFunction(() => document.querySelector("#messages .msg.assistant:last-child")?.classList.contains("error"), null, { timeout: 30000 }).catch(() => {});
const errText = (await meta()) ?? "";
check("chat error: one plain sentence (no raw node text in the line)", /(node|connection|charged)/i.test(errText) && !/test node stops here/.test(errText), errText);
await page.click("#messages .msg.assistant:last-child .meta button:has-text('details')");
const detail = await page.$eval("#side .error-detail pre", (e) => e.textContent).catch(() => "");
check("chat error: the raw text under details", /test node stops here/.test(detail ?? ""), detail);

// Every error code of the library has its own plain sentence.
const codes = await page.evaluate(() => window.__rc.errorCodes);
const generic = await page.evaluate((codes) => codes.filter((c) => /^Something went wrong/.test(window.__rc.friendlyError(c))), codes);
check(`every library error code (${codes.length}) has a plain sentence`, codes.length >= 24 && generic.length === 0, JSON.stringify(generic));
const sample = await page.evaluate(() => ({
  receipt: window.__rc.friendlyError("receipt_verification"),
  timeoutReached: window.__rc.friendlyError("timeout", "slow", { mayHaveReachedProvider: true }),
  timeoutNot: window.__rc.friendlyError("timeout"),
  unreachable: window.__rc.friendlyError("offer_unavailable"),
}));
check("receipt failure: says not to trust the answer", /Do not trust/.test(sample.receipt), sample.receipt);
check("timeout after release: may be charged", /may be charged/.test(sample.timeoutReached) && /not charged/.test(sample.timeoutNot), JSON.stringify(sample));
check("node unreachable: what to do", /Cannot reach the node/.test(sample.unreachable), sample.unreachable);

// A deposit outcome the library flags: a notice in the wallet, until dismissed.
await page.evaluate(() => window.__rc.event({ ev: "warning", code: "deposit_outcome", message: "charged after a releasing receipt" }));
const notice = await page.textContent("#deposit-warnings").catch(() => "");
check("deposit_outcome warning: shown as a notice", /connection deposit/.test(notice ?? "") && /charged after a releasing receipt/.test(notice ?? ""), notice);
await page.click("#deposit-warnings button:has-text('Dismiss')");
check("deposit_outcome warning: dismissed", ((await page.textContent("#deposit-warnings")) ?? "") === "");

await browser.close();
server.close();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}

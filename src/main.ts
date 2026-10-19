import { waterfall } from "./waterfall";
import { combobox } from "./combobox";
import { renderMarkdown, streamingMarkdown } from "./markdown";
import "./style.css";
import qrcode from "qrcode-generator";
import {
  createConfidentialClient,
  formatSats,
  mintInputFees,
  NodeApi,
  offerAbandonFeeMsat,
  offerSessionFeeMsat,
  SessionRejectedError,
  UpstreamImageError,
  offerImages,
  type ConfidentialImagesOffer,
  type ConfidentialImageVariant,
  type MintFee,
  roughTokens,
  costMsat,
  type BalanceInfo,
  type ConfidentialClient,
  type ConfidentialSessionResult,
  type ModelPricing,
  type VerifiedOffer,
} from "@routstr/confidential-web";
import { APP_BUILD, APP_VERSION, idle, setupPwa } from "./pwa";
import { deleteImage, listImages, putImage, reencode, type StoredImage } from "./imagestore";

declare const __GIT_SHA__: string;
declare const __LIB_VERSION__: string;
declare const __LIB_REF__: string;
const APP_REPO = "https://github.com/jooray/routstr-confidential-pwa";
const LIB_REPO = "https://github.com/jooray/routstr-confidential-web";
const HOW_VIDEO = "1235021232"; // Vimeo: "A magic show inside a routstr inference request"

// ─── settings and storage ───────────────────────────────────────────────────

const DEFAULTS = {
  node: "https://routstr.cypherpunk.today",
  pubkey: "2ca46ee98f3134c4e11a638663a45983b590bfdefd31588f9c2f03455fba15e7",
  trustedHost: "api.venice.ai",
};
const K = {
  settings: "rc:settings",
  credential: "rc:credential",
  model: "rc:model",
  maxTokens: "rc:max-tokens",
  prewarm: "rc:prewarm",
  remember: "rc:remember",
  timingNumbers: "rc:timing-numbers",
  theme: "rc:theme",
  reasoning: "rc:reasoning",
  mode: "rc:mode",
  imgModel: "rc:img-model",
  imgVariant: "rc:img-variant",
  imgAspect: "rc:img-aspect",
  imgCount: "rc:img-count",
  meteredWarned: "rc:metered-warned",
};

function load<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
}
function save(k: string, v: unknown): void {
  try {
    if (v === undefined) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

const settings = load(K.settings, { ...DEFAULTS });
let credential: string | undefined = load<string | undefined>(K.credential, undefined);
// Off by default: the key is a bearer credential, and local storage is
// readable by any script this origin serves. A key kept only in memory is
// lost with the tab, so the page asks the user to copy it and warns before
// closing a funded tab. An install that already stored a key before this
// default changed keeps it until the user unticks the box.
let remember = load<boolean>(K.remember, credential !== undefined);
let showTimingNumbers = load(K.timingNumbers, false);

// Colour theme: "auto" follows the system; the choice is kept on this device.
type Theme = "auto" | "light" | "dark";
let theme: Theme = load<Theme>(K.theme, "auto");
const THEME_LABEL: Record<Theme, string> = { auto: "◐ Auto", light: "☀ Light", dark: "☾ Dark" };
function applyTheme(): void {
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  const dark = theme === "dark" || (theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0b1016" : "#f6f7f9");
  const b = document.getElementById("theme-btn");
  if (b) {
    b.textContent = THEME_LABEL[theme];
    b.title = `Colour theme: ${theme} (click to change)`;
  }
}
applyTheme();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
// `?prewarm=0` (tests) or the user's choice in the Costs panel.
let prewarmOn = new URLSearchParams(location.search).get("prewarm") === "0" ? false : load(K.prewarm, true);
let mintFees: MintFee[] | undefined;

// ─── tiny DOM helper ────────────────────────────────────────────────────────

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false || v === null) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k in el && k !== "list") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function kv(pairs: [string, Child][]): HTMLElement {
  const dl = h("dl", { class: "kv" });
  for (const [k, v] of pairs) dl.append(h("dt", {}, k), h("dd", {}, v));
  return dl;
}
function check(ok: boolean, text: string): HTMLElement {
  return h("span", { class: ok ? "check" : "cross" }, text);
}
function short(s: string, n = 10): string {
  return s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string, ms = 4000): void {
  let t = document.querySelector<HTMLElement>(".toast");
  if (!t) {
    t = h("div", { class: "toast", role: "status" });
    document.body.append(t);
  }
  t.textContent = msg;
  t.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t!.classList.add("hidden"), ms);
}

// ─── state ──────────────────────────────────────────────────────────────────

interface Turn {
  role: "user" | "assistant";
  content: string;
  el: HTMLElement;
  result?: ConfidentialSessionResult;
  error?: string;
  meta?: HTMLElement;
}

let client: ConfidentialClient | undefined;
let api = new NodeApi(settings.node);
let offer: VerifiedOffer | undefined;
let offerError: string | undefined;
let pricing: ModelPricing[] = [];
let balance: BalanceInfo | undefined;
let busy = false;
let selected: Turn | undefined;
const turns: Turn[] = [];
const events: string[] = [];
let prewarmStatus = "off";
/** Chat, or confidential image generation (on demand only, never pre-armed). */
let mode: "chat" | "image" = load<"chat" | "image">(K.mode, "chat");
/** The progress line of the image request in flight. */
let imageProgress: HTMLElement | undefined;

function logEvent(e: Record<string, unknown>): void {
  const { t, ...rest } = e;
  const line = `${new Date(Number(t) || Date.now()).toLocaleTimeString()} ${JSON.stringify(rest)}`;
  events.push(line);
  if (events.length > 300) events.shift();
  if (e.kind === "images") imageProgressEvent(e);
  if (e.ev === "prewarm" && typeof e.status === "string") {
    prewarmStatus = e.status;
    renderStatus();
  }
  const log = document.getElementById("log");
  if (log) {
    log.append(h("div", { class: "mono" }, line));
    log.scrollTop = log.scrollHeight;
  }
}

function makeClient(): void {
  client?.close();
  api = new NodeApi(settings.node);
  client = createConfidentialClient({
    node: settings.node,
    nodePubkeys: [settings.pubkey],
    trustedHosts: [settings.trustedHost],
    credential,
    prewarm: { enabled: prewarmOn },
    onEvent: logEvent,
  });
}

// ─── layout ─────────────────────────────────────────────────────────────────

function layout(): void {
  const app = $("app");
  app.replaceChildren(
    h(
      "div",
      { class: "shell" },
      h(
        "header",
        {},
        h("h1", {}, "Confidential Chat"),
        h("span", { class: "pill", id: "offer-pill" }, "offer: …"),
        h("span", { class: "pill", id: "warm-pill", title: "Pre-warmed session" }, "pre-warm: off"),
        h("span", { class: "grow" }),
        h("button", { type: "button", id: "how-btn", class: "icon-btn", onclick: openHowDialog }, "How does this work?"),
        h(
          "button",
          {
            type: "button",
            id: "theme-btn",
            class: "icon-btn",
            "aria-label": "Colour theme",
            onclick: () => {
              theme = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
              save(K.theme, theme);
              applyTheme();
            },
          },
          THEME_LABEL[theme],
        ),
        h("span", { class: "muted", title: `build ${APP_BUILD}` }, `v${APP_VERSION}`),
      ),
      h(
        "main",
        {},
        h(
          "section",
          { class: "chat" },
          h(
            "div",
            { class: "toolbar" },
            h(
              "span",
              { class: "mode-switch", role: "group", "aria-label": "Mode" },
              h("button", { type: "button", id: "mode-chat", onclick: () => setMode("chat") }, "Chat"),
              h("button", { type: "button", id: "mode-image", onclick: () => setMode("image") }, "Image"),
            ),
            h("span", { class: "toolbar-group", id: "image-controls" }, ...imageControls()),
            h(
              "span",
              { class: "toolbar-group", id: "chat-controls" },
            modelPicker.el,
            h("label", { class: "inline" }, "max tokens", h("input", { id: "max-tokens", type: "number", min: 1, step: 1, style: "width:90px", onchange: onModelChange })),
            h(
              "label",
              { class: "inline", title: "reasoning_effort sent to the provider (models that do not support it ignore it). 'model default' sends nothing." },
              "reasoning",
              h(
                "select",
                {
                  id: "reasoning",
                  onchange: (e: Event) => save(K.reasoning, (e.target as HTMLSelectElement).value),
                },
                ...["default", "none", "low", "medium", "high"].map((v) =>
                  h("option", { value: v, selected: v === load(K.reasoning, "default") }, v === "default" ? "model default" : v),
                ),
              ),
            ),
            h("span", { class: "est", id: "estimate" }),
            h("button", { type: "button", id: "clear-chat", class: "secondary", title: "Clear the conversation", onclick: clearChat }, "New chat"),
            ),
          ),
          h("div", { class: "messages", id: "messages" }, emptyState()),
          h("div", { class: "messages gallery", id: "gallery" }),
          h(
            "form",
            { class: "composer", onsubmit: onSend },
            h("textarea", {
              id: "prompt",
              rows: 2,
              placeholder: "Ask something. The node relays it encrypted; only the provider and you can read it.",
              // Typing an image prompt must not arm a chat session.
              oninput: () => {
                if (mode === "chat") client?.activity();
                renderEstimate();
              },
              onfocus: () => {
                if (mode === "chat") client?.activity();
              },
              onkeydown: (e: KeyboardEvent) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  $("send").click();
                }
              },
            }),
            h("button", { class: "primary", id: "send", type: "submit" }, "Send"),
          ),
        ),
        h("aside", { id: "side" }),
      ),
      footer(),
    ),
  );
  // Reasoning models think before answering; 1024 is often used up by the thinking alone.
  // 1024 was the old default: move it up too.
  const savedMax = load<number>(K.maxTokens, 4096);
  $<HTMLInputElement>("max-tokens").value = String(savedMax === 1024 ? 4096 : savedMax);
  applyMode();
}

/** What this page runs, so users can check it against the sources. */
function footer(): HTMLElement {
  const sha = __GIT_SHA__;
  const libRef = __LIB_REF__;
  const link = (href: string, text: string) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);
  return h(
    "footer",
    {},
    "App v",
    APP_VERSION,
    " (",
    /^[0-9a-f]{7,40}$/.test(sha) ? link(`${APP_REPO}/commit/${sha}`, `commit ${sha.slice(0, 7)}`) : `commit ${sha}`,
    `, built ${APP_BUILD.slice(0, 16).replace("T", " ")} UTC) · library @routstr/confidential-web v${__LIB_VERSION__} (`,
    /^[0-9a-f]{7,40}$/.test(libRef) ? link(`${LIB_REPO}/commit/${libRef}`, `commit ${libRef.slice(0, 7)}`) : libRef,
    ") · source: ",
    link(APP_REPO, "routstr-confidential-pwa"),
    ", ",
    link(LIB_REPO, "routstr-confidential-web"),
    " · ",
    link("./version.json", "version.json"),
  );
}

function emptyState(): HTMLElement {
  return h(
    "div",
    { class: "empty", id: "empty" },
    h("p", {}, "Every message runs as a confidential session: your browser is the TLS client of the provider, the node only relays encrypted records and inserts its API key, and zero-knowledge proofs keep both sides honest."),
    h("p", { class: "muted" }, "Fund the wallet (Lightning or Cashu), pick a model, and ask."),
  );
}

// ─── side panel ─────────────────────────────────────────────────────────────

function renderSide(): void {
  const side = $("side");
  side.replaceChildren(
    h("h2", {}, "Costs"),
    costsCard(),
    h("h2", {}, "Wallet"),
    walletCard(),
    h("h2", { id: "verification" }, "Verification"),
    verificationPanel(),
    h("h2", {}, "Node"),
    nodeCard(),
    h("h2", {}, "Events"),
    h("div", { class: "card log", id: "log" }, ...events.map((l) => h("div", { class: "mono" }, l))),
  );
}

function walletCard(): HTMLElement {
  const card = h("div", { class: "card" });
  if (credential) {
    const avail = balance ? balance.balance - balance.reserved : undefined;
    card.append(
      h("div", { class: "balance", id: "bal" }, balance ? formatSats(balance.balance) : "…"),
      h("div", { class: "muted", id: "bal-sub" }, balanceSub(avail)),
      h(
        "details",
        {},
        h("summary", {}, "Your key"),
        h("div", { class: "row" }, h("code", {}, short(credential, 8)), h("button", { type: "button", onclick: () => copy(credential!, "Key copied") }, "Copy")),
        h(
          "label",
          { class: "inline" },
          h("input", {
            type: "checkbox",
            checked: remember,
            onchange: (e: Event) => {
              remember = (e.target as HTMLInputElement).checked;
              save(K.remember, remember);
              save(K.credential, remember ? credential : undefined);
            },
          }),
          "Remember on this device",
        ),
        h(
          "p",
          { class: "warnbox" },
          "The key is a bearer credential: anyone with it can spend the balance. Stored keys sit in this site's local storage, readable by any script this origin serves. Keep balances small.",
        ),
      ),
    );
  } else {
    card.append(
      h("p", { class: "muted" }, "No funds yet. Pay a Lightning invoice or paste a Cashu token; the node gives you an sk- key that holds the balance."),
    );
  }
  card.append(
    h(
      "div",
      { class: "row" },
      h("input", { id: "ln-amount", type: "number", min: 1, value: "500", "aria-label": "Amount in sats" }),
      h("button", { type: "button", onclick: onLightning }, "Lightning"),
    ),
    h("div", { id: "invoice" }),
    h("p", { class: "muted" }, "Lightning: your wallet may add a routing fee on top of the invoice amount."),
    h(
      "details",
      {},
      h("summary", {}, "Pay with Cashu"),
      mintFeeLines(),
      h("textarea", { id: "cashu", rows: 3, placeholder: "cashuB…" }),
      h("button", { type: "button", onclick: onCashu }, credential ? "Top up" : "Create key"),
    ),
    h(
      "details",
      {},
      h("summary", {}, "Use an existing key"),
      h("input", { id: "paste-key", placeholder: "sk-…", autocomplete: "off" }),
      h("button", { type: "button", onclick: onPasteKey }, "Use key"),
    ),
  );
  if (credential) {
    card.append(
      h(
        "details",
        {},
        h("summary", {}, "Withdraw (refund)"),
        h("p", { class: "muted" }, "Returns the whole balance as a Cashu token (or to a Lightning address) and empties the key. The mint's input fee or the Lightning routing fee comes out of the amount."),
        h("input", { id: "refund-ln", placeholder: "Lightning address (optional)" }),
        h("button", { type: "button", onclick: onRefund }, "Withdraw"),
        h("div", { id: "refund-out" }),
      ),
    );
  }
  return card;
}

/** Plain-language costs, all read from the signed offer and the node's model list. */
function costsCard(): HTMLElement {
  const card = h("div", { class: "card", id: "costs" });
  if (!offer) {
    card.append(h("p", { class: "muted" }, offerError ? "No verified offer: nothing can be priced." : "Loading the node's signed prices…"));
    return card;
  }
  const abandon = offerAbandonFeeMsat(offer);
  const sessionFee = offerSessionFeeMsat(offer);
  const pct = typeof offer.rate_surcharge_pct === "number" ? offer.rate_surcharge_pct : 0;
  card.append(
    h(
      "p",
      {},
      h("strong", {}, "Prices: "),
      "the line under the model shows the selected model's signed rates, a typical message's cost and the balance it needs. ",
      "You pay the provider-reported usage at those rates",
      sessionFee ? `, plus a session fee of ${formatSats(sessionFee)}` : "",
      pct ? ` (rates include a ${pct}% confidential surcharge)` : "",
      ". While a request runs, the node holds its worst case (a prompt filling the model's whole context plus the max tokens",
      abandon || sessionFee ? `, plus the ${formatSats(Math.max(abandon, sessionFee))} fee` : "",
      ") and releases the rest when it settles. Each answer shows its exact cost from the signed receipt.",
    ),
    h(
      "p",
      {},
      h("strong", {}, "Pre-warming: "),
      abandon > 0
        ? `keeping a session ready makes the first answer faster. It costs nothing if you use it; a prepared session you never use costs ${formatSats(abandon)} (the node's fee for the work it already did). It is only prepared while this page is visible and you have funds.`
        : "keeping a session ready makes the first answer faster and costs nothing extra. It is only prepared while this page is visible and you have funds.",
    ),
    h(
      "label",
      { class: "inline" },
      h("input", {
        type: "checkbox",
        checked: prewarmOn,
        onchange: (e: Event) => {
          prewarmOn = (e.target as HTMLInputElement).checked;
          save(K.prewarm, prewarmOn);
          client?.setPrewarm(prewarmOn);
          if (prewarmOn) {
            const m = currentModel();
            if (m) client?.prepare(m.id, maxTokens());
          }
        },
      }),
      "Keep a session ready (pre-warm)",
    ),
  );
  if (abandon > 5000) card.append(h("p", { class: "warnbox" }, "This node's unused-session fee is above 5 sats, so the app does not pre-warm."));
  return card;
}

function mintFeeLines(): HTMLElement {
  if (!mintFees) return h("p", { class: "muted" }, "Checking the mints' fees…");
  const paid = mintFees.filter((m) => (m.inputFeePpk ?? 0) > 0);
  return h(
    "div",
    { class: "muted" },
    h(
      "p",
      {},
      "Cashu mints may charge an input fee when your token is redeemed (and again when you withdraw): ",
      paid.length
        ? `${paid.map((m) => `${new URL(m.mint).host} ${m.inputFeePpk} ppk`).join(", ")} — that is about ${Math.ceil((paid[0]!.inputFeePpk ?? 0) / 1000)} sat per proof batch of up to ${Math.floor(1000 / Math.max(1, paid[0]!.inputFeePpk ?? 1))} proofs, rounded up.`
        : "the node's mints charge none.",
      ` Mints this node accepts: ${(offer?.mints ?? []).map((m) => new URL(m).host).join(", ") || "—"}.`,
    ),
  );
}

function currentModelOrNull(): ModelPricing | undefined {
  return pricing.find((p) => p.id === modelPicker.value);
}

function balanceSub(avail?: number): string {
  return balance
    ? `${formatSats(avail ?? 0)} available · ${formatSats(balance.reserved)} reserved by open sessions`
    : "loading balance";
}

function nodeCard(): HTMLElement {
  return h(
    "div",
    { class: "card" },
    h("div", { class: "field" }, "Node URL", h("input", { id: "set-node", value: settings.node })),
    h("div", { class: "field" }, "Node key (hex or npub, pinned)", h("input", { id: "set-pubkey", value: settings.pubkey })),
    h("div", { class: "field" }, "Trusted provider host", h("input", { id: "set-host", value: settings.trustedHost })),
    h(
      "div",
      { class: "row" },
      h("button", { type: "button", onclick: onSaveSettings }, "Apply"),
      h("button", { type: "button", onclick: () => { Object.assign(settings, DEFAULTS); save(K.settings, settings); void restart(); } }, "Defaults"),
    ),
    offer
      ? kv([
          ["offer", check(true, "signature valid, key pinned")],
          ["node key", h("code", {}, short(offer.notary_pubkey))],
          ["provider", check(true, `${offer.upstream_host} (trusted)`)],
          ["protocol", `v${offer.v} (two-party handshake)`],
          ["session fee", offer.session_fee_msat ? formatSats(offer.session_fee_msat) : "none"],
        ])
      : h("p", { class: offerError ? "cross" : "muted" }, offerError ?? "loading offer…"),
  );
}

function verificationPanel(): HTMLElement {
  const r = selected?.result;
  if (!r) {
    return h(
      "div",
      { class: "card muted" },
      selected?.error ? h("span", { class: "cross" }, selected.error) : "Send a message to see what your browser verified: the provider's certificate, the proofs, the signed receipt and the timings.",
    );
  }
  const p = r.provider;
  const t = r.timings;
  const usage = r.ownUsage?.usage as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined;
  const rates = offer?.price_list[r.model];
  const fee = offer?.session_fee_msat ?? 0;
  const proofRow = (name: string, label: string) => {
    const x = t.proofs?.[name];
    return [label, x ? check(x.ok, `ok · ${x.ms} ms (${x.via})`) : check(false, "not run")] as [string, Child];
  };
  const ms = (v?: number) => (v === undefined ? "—" : `${Math.round(v)} ms`);
  return h(
    "div",
    {},
    h(
      "div",
      { class: "card" },
      h("strong", {}, "Provider connection"),
      p
        ? kv([
            ["host", check(true, `${p.host}${p.hostnameMatched ? ` (matched ${p.hostnameMatched})` : ""}`)],
            ["TLS", `${p.tlsVersion} · ${p.cipherSuite}${p.alpn ? ` · ${p.alpn}` : ""}`],
            ["key exchange", p.keyExchange],
            ["chain", check(true, "validated to a bundled Mozilla root in this browser")],
          ])
        : h("p", { class: "cross" }, "no certificate data"),
      p
        ? h(
            "ol",
            { class: "chain" },
            ...p.chain.map((c, i) =>
              h(
                "li",
                {},
                h("div", {}, h("strong", {}, i === 0 ? "leaf " : c.trustAnchor ? "root " : "intermediate "), c.subject),
                h(
                  "details",
                  {},
                  h("summary", {}, "details"),
                  kv([
                    ["issuer", c.issuer],
                    ["valid", `${c.notBefore.slice(0, 10)} → ${c.notAfter.slice(0, 10)}`],
                    ["SAN", c.dnsNames.join(", ") || "—"],
                    ["SPKI sha256", h("code", {}, c.spkiSha256Base64)],
                    ["cert sha256", h("code", {}, c.fingerprintSha256)],
                    ["key", c.publicKeyAlgorithm],
                    ["signature", c.signatureAlgorithm],
                    ["serial", h("code", {}, c.serialNumber)],
                  ]),
                ),
              ),
            ),
          )
        : null,
    ),
    h(
      "div",
      { class: "card" },
      h("strong", {}, "Proofs"),
      kv([
        ["2PC handshake", check(true, `key schedule run jointly · A ${ms(t.twoPcPhaseAMs)} · B ${ms(t.twoPcPhaseBMs)}`)],
        proofRow("pi_nk", "π_NK (node key record)"),
        proofRow("pi_c2s", "π_C2S (pinned suffix)"),
        r.imageVariant !== undefined && !t.proofs?.pi_c3s
          ? ["π_C3S (usage disclosure)", check(true, "not needed: flat price fixed at setup")]
          : proofRow("pi_c3s", "π_C3S (usage disclosure)"),
        ["attestation", check(r.attestationSigOk, "signature valid")],
      ]),
    ),
    h(
      "div",
      { class: "card" },
      h("strong", {}, "Receipt"),
      kv([
        ["signature", check(r.receiptSigOk, "valid (node key)")],
        r.imageVariant !== undefined
          ? [
              "charge",
              check(
                r.usageMatch,
                r.http.status >= 400
                  ? `provider error ${r.http.status}`
                  : `${r.imageCount} × ${formatSats(Number(r.receipt.msat_per_image ?? 0))} (${r.imageVariant}, the signed flat price)`,
              ),
            ]
          : ["usage", check(r.usageMatch, usage ? `${usage.prompt_tokens} in / ${usage.completion_tokens} out (matches our plaintext)` : "error response")],
        ["cost", check(r.costWithinOffer, `${formatSats(r.costMsats ?? 0)} (≤ signed rates${fee ? " + session fee" : ""})`)],
        [
          "at the rates",
          rates && usage
            ? formatSats(
                costMsat(rates, {
                  prompt_tokens: usage.prompt_tokens ?? 0,
                  completion_tokens: usage.completion_tokens ?? 0,
                  cached_tokens: usage.prompt_tokens_details?.cached_tokens,
                }, fee),
              )
            : "—",
        ],
        ["reserved", r.receipt.reserved_msats !== undefined ? formatSats(r.receipt.reserved_msats) : "—"],
        ["balance after", typeof r.receipt.balance_msats === "number" ? formatSats(r.receipt.balance_msats) : "—"],
        ["session", h("code", {}, short(r.sid, 8))],
      ]),
      h("details", {}, h("summary", {}, "signed receipt JSON"), h("pre", {}, r.receiptJson), h("div", { class: "mono" }, `sig ${r.receiptSig ?? ""}`)),
    ),
    h(
      "div",
      { class: "card timing" },
      h(
        "div",
        { class: "timing-head" },
        h("strong", {}, r.prewarmed ? "Timeline (warm: pre-armed session)" : "Timeline (cold)"),
        h("button", { type: "button", class: "icon-btn", title: "Show larger", "aria-label": "Show the timeline larger", onclick: () => openTimelineDialog(r) }, "⤢"),
        h(
          "label",
          { class: "inline" },
          h("input", {
            type: "checkbox",
            checked: showTimingNumbers,
            onchange: (e: Event) => {
              showTimingNumbers = (e.target as HTMLInputElement).checked;
              save(K.timingNumbers, showTimingNumbers);
              renderSide();
            },
          }),
          "numbers",
        ),
      ),
      waterfall(t.spans ?? [], { ttftMs: r.ttftMs, numbers: showTimingNumbers }),
      !showTimingNumbers ? null : kv([
        [r.images ? "first byte of the image" : "first token", ms(r.ttftMs)],
        ["total", ms(r.totalMs)],
        ["arm (setup + 2PC preprocessing)", r.prewarmed ? `${ms(t.armMs)} (before the request)` : ms(t.armMs)],
        ["2PC key share", ms(t.twoPcKeyShareMs)],
        ["handshake (2PC A + B)", ms(t.handshakeMs)],
        ["π_NK", ms(t.piNkMs)],
        ["credential record", ms(t.recordMs)],
        ["provider first byte", ms(t.upstreamTtftMs)],
        ["2PC traffic", t.twoPcBytes ? `${(t.twoPcBytes.sent / 1e6).toFixed(2)} MB up · ${(t.twoPcBytes.recv / 1e6).toFixed(1)} MB down` : "—"],
      ]),
      showTimingNumbers && t.twoPcSteps?.length
        ? h("details", {}, h("summary", {}, "2PC steps (wasm)"), kv(t.twoPcSteps.map((s) => [s.step, `${Math.round(s.ms)} ms`] as [string, Child])))
        : null,
    ),
  );
}

/** The timeline, large, in a modal dialog with the step legend explained. */
function openTimelineDialog(r: ConfidentialSessionResult): void {
  document.getElementById("wf-dialog")?.remove();
  const dlg = document.createElement("dialog");
  dlg.id = "wf-dialog";
  dlg.className = "wf-dialog";
  const t = r.timings;
  const ms = (v?: number) => (v === undefined ? "—" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
  dlg.append(
    h(
      "div",
      { class: "wf-dialog-head" },
      h(
        "strong",
        {},
        `${r.prewarmed ? "Warm (pre-armed)" : r.waitedForArmMs !== undefined ? "Waited for pre-arm" : "Cold"} ${r.images ? "image request · first byte" : "request · first token"} ${ms(r.ttftMs)} · total ${ms(r.totalMs)}`,
      ),
      h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: () => dlg.close() }, "✕"),
    ),
    waterfall(t.spans ?? [], { ttftMs: r.ttftMs, numbers: true, large: true }),
    h(
      "p",
      { class: "muted wf-explain" },
      "Time runs left to right; the blue line is when you sent the message. ",
      r.prewarmed
        ? "Everything left of it happened beforehand: the session was set up and the two-party (2PC) preparation, the large part, ran while you were typing. "
        : r.waitedForArmMs !== undefined
          ? `A session was still being prepared when you sent the message; the request waited ${ms(r.waitedForArmMs)} for its two-party (2PC) preparation to finish. `
          : "This request had no prepared session, so the 2PC preparation ran after you sent it. ",
      r.images
        ? "After sending: the TLS handshake with the provider, whose keys the browser and the node compute together (2PC phases A and B); π_NK proves the node's credential record matches the published template; the node writes it; the provider generates the image (the red dashed line is its first byte) and the browser downloads and decrypts it. π_C2S proves the pinned model, resolution and count before the provider sees them. No usage proof is needed: the browser accepts the result and the node charges the signed flat price."
        : "After sending: the TLS handshake with the provider, whose keys the browser and the node compute together (2PC phases A and B); π_NK proves the node's credential record matches the published template; the node writes it; the provider starts answering (the red dashed line is the first token). π_C2S proves the pinned model and token cap before the provider sees them, and π_C3S discloses only the usage for the receipt.",
    ),
  );
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close();
  });
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

/** Explainer video (Vimeo, loaded only when opened) and links to the guide, the paper and the sources. */
function openHowDialog(): void {
  document.getElementById("how-dialog")?.remove();
  const dlg = document.createElement("dialog");
  dlg.id = "how-dialog";
  dlg.className = "wf-dialog how-dialog";
  const link = (href: string, text: string) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);
  const GH = "https://github.com/jooray/";
  const BLOG = "https://juraj.bednar.io/";
  const iframe = h("iframe", {
    src: `https://player.vimeo.com/video/${HOW_VIDEO}?badge=0&autopause=0&dnt=1`,
    title: "A magic show inside a routstr inference request",
    allow: "autoplay; fullscreen; picture-in-picture; clipboard-write; encrypted-media; web-share",
    referrerpolicy: "strict-origin-when-cross-origin",
    allowFullscreen: true,
  });
  dlg.append(
    h(
      "div",
      { class: "wf-dialog-head" },
      h("strong", {}, "How does this work?"),
      h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: () => dlg.close() }, "✕"),
    ),
    h("div", { class: "how-video" }, iframe),
    h(
      "p",
      { class: "muted" },
      "The protocol told as a magic show (35 minutes, video from Vimeo). The short written version, with the same video: ",
      link(`${BLOG}en/blog-en/2026/10/12/seven-magic-tricks-inside-one-ai-request/`, "Seven magic tricks inside one AI request"),
      ".",
    ),
    h(
      "ul",
      { class: "how-links" },
      h("li", {}, "Programmer's guide: ", link(`${BLOG}wp-content/uploads/2026/10/routstr-confidential-for-programmers.pdf`, "How routstr confidential mode works"), " (PDF, 72 pages; ", link(`${BLOG}wp-content/uploads/2026/10/routstr-confidential-pre-programatorov.pdf`, "Slovak edition"), ")"),
      h("li", {}, "Paper: ", link(`${GH}routstr-confidential/blob/HEAD/paper/paper.pdf`, "Confidential and verifiable upstream inference over standard TLS 1.3")),
      h("li", {}, "Introduction: ", link(`${BLOG}en/blog-en/2026/10/10/confidential-inference-on-routstr-without-trusted-hardware/`, "Confidential inference on Routstr without trusted hardware"), " (blog post)"),
      h("li", {}, "Protocol and node sidecar: ", link(`${GH}routstr-confidential`, "routstr-confidential"), " (", link(`${GH}routstr-confidential/blob/HEAD/docs/SETUP.md`, "setup guide"), ")"),
      h("li", {}, "Browser library: ", link(LIB_REPO, "routstr-confidential-web"), " · this app: ", link(APP_REPO, "routstr-confidential-pwa")),
      h("li", {}, "Routstr integration branches: ", link(`${GH}routstr-core/tree/confidential-2pc`, "routstr-core"), ", ", link(`${GH}routstr-sdk/tree/confidential-2pc`, "routstr-sdk"), ", ", link(`${GH}routstrd/tree/confidential-upstream`, "routstrd")),
    ),
  );
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close();
  });
  dlg.addEventListener("close", () => dlg.remove()); // removing the iframe stops the video
  document.body.append(dlg);
  dlg.showModal();
}

// ─── header, models, estimate ───────────────────────────────────────────────

function renderStatus(): void {
  const op = document.getElementById("offer-pill");
  if (op) {
    op.className = `pill ${offer ? "ok" : offerError ? "bad" : ""}`;
    op.textContent = offer ? "offer verified" : offerError ? "offer rejected" : "offer: …";
    op.title = offerError ?? (offer ? `signed by ${offer.notary_pubkey}` : "");
  }
  const wp = document.getElementById("warm-pill");
  if (wp) {
    wp.className = `pill ${prewarmStatus === "armed" ? "ok" : prewarmStatus === "arming" ? "warn" : ""}`;
    wp.textContent = `pre-warm: ${prewarmStatus}`;
  }
}

const DEFAULT_MODEL = "deepseek-v4-flash-0731";
const modelPicker = combobox({ id: "model", ariaLabel: "Model (type to filter)", onPick: () => onModelChange() });

function renderModels(): void {
  const saved = load<string>(K.model, "");
  const want = [saved, DEFAULT_MODEL].find((id) => id && pricing.some((p) => p.id === id)) ?? pricing[0]?.id ?? "";
  renderModelOptions(want);
  renderEstimate();
}

/** The model picker's items, by name, with their rates. */
function renderModelOptions(want: string): void {
  const sorted = [...pricing].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
  modelPicker.setItems(
    sorted.map((p) => ({
      id: p.id,
      label: p.name ?? p.id,
      detail: `in ${formatSats(p.rates.in * 1000)}/M · out ${formatSats(p.rates.out * 1000)}/M`,
    })),
    want,
  );
}

function currentModel(): ModelPricing | undefined {
  return currentModelOrNull();
}

function maxTokens(): number {
  const v = Number($<HTMLInputElement>("max-tokens").value);
  const cap = offer?.max_tokens_cap ?? 4096;
  return Number.isFinite(v) && v > 0 ? Math.min(Math.trunc(v), cap) : cap;
}

function renderEstimate(): void {
  const p = currentModel();
  const el = document.getElementById("estimate");
  if (!el || !p) return;
  const prompt = ($<HTMLTextAreaElement>("prompt")?.value ?? "") + turns.map((t) => t.content).join("");
  const inTok = roughTokens(prompt) + 20;
  const mt = maxTokens();
  const typical = costMsat(p.rates, { prompt_tokens: inTok, completion_tokens: Math.min(mt, 300) }, p.sessionFeeMsat);
  const worst = costMsat(p.rates, { prompt_tokens: inTok, completion_tokens: mt }, p.sessionFeeMsat);
  const resv =
    p.promptLimit !== undefined
      ? Math.ceil((p.promptLimit * p.rates.in + mt * p.rates.out) / 1000) + Math.max(p.sessionFeeMsat, p.abandonFeeMsat)
      : undefined;
  el.textContent =
    `≈ ${formatSats(typical)} per message (≤ ${formatSats(worst)} at ${mt} tokens)` +
    (resv !== undefined ? ` · needs ${formatSats(resv)} available (reserved while it runs)` : "") +
    (p.abandonFeeMsat ? ` · unused prepared session ${formatSats(p.abandonFeeMsat)}` : "") +
    (p.sessionFeeMsat ? ` · incl. session fee ${formatSats(p.sessionFeeMsat)}` : "") +
    (p.rateSurchargePct ? ` · rates incl. ${p.rateSurchargePct}% surcharge` : "");
}

function onModelChange(): void {
  const p = currentModel();
  if (!p) return;
  save(K.model, p.id);
  save(K.maxTokens, maxTokens());
  client?.prepare(p.id, maxTokens());
  renderEstimate();
  void client?.pricing(maxTokens()).then((list) => {
    pricing = list;
    document.getElementById("costs")?.replaceWith(costsCard());
  });
}

// ─── wallet actions ─────────────────────────────────────────────────────────

async function refreshBalance(): Promise<void> {
  if (!credential?.startsWith("sk-")) {
    balance = undefined;
    return;
  }
  const had = balance !== undefined;
  try {
    balance = await api.balance(credential);
  } catch (e) {
    logEvent({ ev: "balance_error", msg: String(e) });
  }
  const bal = document.getElementById("bal");
  if (had && bal && balance) {
    // Update in place: do not wipe what the user is typing in the side panel.
    bal.textContent = formatSats(balance.balance);
    $("bal-sub").textContent = balanceSub(balance.balance - balance.reserved);
  } else renderSide();
}

/** What to tell the user about a new funded key: copy it, and whether it is stored. */
function fundedKeyNotice(what: string): string {
  return remember
    ? `${what} The key is remembered on this device; copy it too, so the balance is not lost if site data is cleared.`
    : `${what} Copy your key (Wallet → Your key): it is kept only in this tab unless you tick "Remember on this device".`;
}

function setCredential(key: string | undefined): void {
  credential = key;
  balance = undefined;
  save(K.credential, remember && key ? key : undefined);
  client?.setCredential(key);
  void refreshBalance().then(() => {
    const p = currentModel();
    if (p) client?.prepare(p.id, maxTokens());
  });
}

async function copy(text: string, msg: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    toast("Copy failed; select the text manually");
  }
}

let invoicePoll: ReturnType<typeof setInterval> | undefined;
async function onLightning(): Promise<void> {
  const amount = Math.trunc(Number($<HTMLInputElement>("ln-amount").value));
  if (!(amount > 0)) return toast("Enter an amount in sats");
  const box = $("invoice");
  box.replaceChildren(h("p", { class: "muted" }, "Creating invoice…"));
  try {
    const inv = await api.lightningInvoice(amount, credential?.startsWith("sk-") ? credential : undefined);
    const qr = qrcode(0, "L");
    qr.addData(inv.bolt11.toUpperCase(), "Alphanumeric");
    qr.make();
    box.replaceChildren(
      h("div", { class: "qr" }, h("img", { src: qr.createDataURL(6, 2), alt: "Lightning invoice QR code" })),
      h("div", { class: "row" }, h("a", { href: `lightning:${inv.bolt11}` }, "Open in wallet"), h("button", { type: "button", onclick: () => copy(inv.bolt11, "Invoice copied") }, "Copy invoice")),
      h("p", { class: "muted", id: "inv-status" }, `${amount} sat · waiting for payment…`),
    );
    if (invoicePoll) clearInterval(invoicePoll);
    const started = Date.now();
    invoicePoll = setInterval(async () => {
      if (Date.now() > inv.expires_at * 1000 || Date.now() - started > 3_600_000) {
        clearInterval(invoicePoll);
        $("inv-status").textContent = "Invoice expired";
        return;
      }
      try {
        const st = await api.lightningStatus(inv.invoice_id);
        if (st.status === "paid") {
          clearInterval(invoicePoll);
          box.replaceChildren(h("p", { class: "check" }, `Paid ${st.amount_sats} sat`));
          if (st.api_key && st.api_key !== credential) {
            setCredential(st.api_key);
            toast(fundedKeyNotice("Funded."), 10000);
          } else void refreshBalance();
        } else if (st.status === "expired") {
          clearInterval(invoicePoll);
          $("inv-status").textContent = "Invoice expired";
        }
      } catch {
        /* keep polling */
      }
    }, 3000);
  } catch (e) {
    box.replaceChildren(h("p", { class: "cross" }, String(e instanceof Error ? e.message : e)));
  }
}

async function onCashu(): Promise<void> {
  const token = $<HTMLTextAreaElement>("cashu").value.trim();
  if (!token.startsWith("cashu")) return toast("Paste a Cashu token (cashuA… / cashuB…)");
  try {
    if (credential?.startsWith("sk-")) {
      await api.topupCashu(credential, token);
      toast("Topped up");
      void refreshBalance();
    } else {
      const r = await api.createKeyFromCashu(token);
      setCredential(r.api_key);
      toast(fundedKeyNotice("Key created."), 10000);
    }
    $<HTMLTextAreaElement>("cashu").value = "";
  } catch (e) {
    toast(`Cashu failed: ${e instanceof Error ? e.message : e}`, 8000);
  }
}

function onPasteKey(): void {
  const k = $<HTMLInputElement>("paste-key").value.trim();
  if (!k.startsWith("sk-")) return toast("Expected an sk- key");
  setCredential(k);
}

async function onRefund(): Promise<void> {
  if (!credential) return;
  if (!confirm("Withdraw the whole balance and empty this key?")) return;
  const ln = $<HTMLInputElement>("refund-ln").value.trim() || undefined;
  client?.prewarmer?.teardown("refund");
  try {
    const r = await api.refund(credential, ln);
    const out = $("refund-out");
    if (typeof r.token === "string") {
      out.replaceChildren(
        h("p", { class: "check" }, "Withdrawn as a Cashu token. Redeem it in any Cashu wallet:"),
        h("textarea", { rows: 4, readOnly: true, value: r.token }),
        h("button", { type: "button", onclick: () => copy(r.token as string, "Token copied") }, "Copy token"),
      );
    } else out.replaceChildren(h("p", { class: "check" }, "Withdrawal sent."), h("pre", {}, JSON.stringify(r, null, 2)));
    void refreshBalance();
  } catch (e) {
    toast(`Refund failed: ${e instanceof Error ? e.message : e}`, 8000);
  }
}

// ─── chat ───────────────────────────────────────────────────────────────────

/** `reasoning_effort` when one is chosen (sent inside the encrypted body; the node never sees it). */
function reasoningParam(): { reasoning_effort?: string } {
  const v = ($<HTMLSelectElement>("reasoning")?.value ?? "default");
  return v === "default" ? {} : { reasoning_effort: v };
}

function clearChat(): void {
  if (busy) return toast("Wait for the current answer to finish");
  turns.length = 0;
  selected = undefined;
  $("messages").replaceChildren(emptyState());
  renderSide();
  renderEstimate();
}

function addTurn(role: Turn["role"], content: string): Turn {
  document.getElementById("empty")?.remove();
  const el = h("div", { class: `msg ${role}` }, role === "assistant" ? "" : content);
  if (role === "assistant" && content) {
    const body = h("div", { class: "md" }, "");
    body.innerHTML = renderMarkdown(content);
    el.append(body);
  }
  const t: Turn = { role, content, el };
  $("messages").append(el);
  turns.push(t);
  el.scrollIntoView({ block: "end" });
  return t;
}

function selectTurn(t: Turn): void {
  selected = t;
  for (const x of turns) x.el.classList.remove("selected");
  renderSide();
}

/** "details": select this answer and bring its verification into view. */
function showDetails(t: Turn): void {
  selectTurn(t);
  if (turns.filter((x) => x.role === "assistant").length > 1) t.el.classList.add("selected");
  const v = document.getElementById("verification");
  if (!v) return;
  v.scrollIntoView({ behavior: "smooth", block: "start" });
  const panel = v.nextElementSibling;
  panel?.classList.remove("flash");
  void (panel as HTMLElement | null)?.offsetWidth; // restart the animation
  panel?.classList.add("flash");
}

async function onSend(e: Event): Promise<void> {
  e.preventDefault();
  if (mode === "image") return onSendImage();
  if (busy || !client) return;
  const ta = $<HTMLTextAreaElement>("prompt");
  const text = ta.value.trim();
  if (!text) return;
  const p = currentModel();
  if (!p) return toast("No confidential model available");
  if (!credential) return toast("Fund the wallet first (Lightning or Cashu)");
  ta.value = "";
  addTurn("user", text);
  // An empty answer (cut off while reasoning) is not sent back as history.
  const history = turns.filter((t) => !t.error && t.content).map((t) => ({ role: t.role, content: t.content }));
  const answer = addTurn("assistant", "");
  const body = h("div", { class: "md" }, "");
  const view = streamingMarkdown(body);
  // Reasoning models stream their thinking separately (reasoning_content):
  // collapsed; click to expand (it keeps streaming inside).
  const thinkingText = h("div", { class: "thinking-text" }, "");
  const thinking = h("details", { class: "thinking", hidden: true }, h("summary", {}, "thinking…"), thinkingText);
  let reasoning = "";
  let finish: string | null | undefined;
  const meta = h("div", { class: "meta" }, "starting confidential session…");
  answer.el.replaceChildren(thinking, body, meta);
  answer.meta = meta;
  busy = true;
  $<HTMLButtonElement>("send").disabled = true;
  const t0 = performance.now();
  try {
    const stream = await client.chat.completions.create({
      model: p.id,
      messages: history,
      max_tokens: maxTokens(),
      ...reasoningParam(),
      stream: true,
    });
    meta.textContent = "streaming (records verified as they decrypt)…";
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta as { content?: string; reasoning_content?: string; reasoning?: string } | undefined;
      finish = choice?.finish_reason ?? finish;
      const r = delta?.reasoning_content ?? delta?.reasoning;
      if (r) {
        if (!reasoning) thinking.hidden = false;
        reasoning += r;
        thinkingText.textContent = reasoning;
        if (!answer.content) thinking.querySelector("summary")!.textContent = `thinking… (${reasoning.length.toLocaleString()} characters)`;
        thinkingText.scrollTop = thinkingText.scrollHeight;
        answer.el.scrollIntoView({ block: "end" });
      }
      const d = delta?.content;
      if (d) {
        answer.content += d;
        view.set(answer.content);
        answer.el.scrollIntoView({ block: "end" });
      }
    }
    view.flush();
    if (reasoning) thinking.querySelector("summary")!.textContent = `reasoning (${reasoning.length.toLocaleString()} characters)`;
    if (finish === "length") {
      body.after(
        h(
          "div",
          { class: "notice" },
          answer.content
            ? `The answer was cut off at the max tokens limit (${maxTokens()}). Raise it to get longer answers.`
            : `No answer: the model spent all ${maxTokens()} max tokens on reasoning before it started answering. Set reasoning to low or none, or raise max tokens (up to ${offer?.max_tokens_cap ?? 4096}), and ask again.`,
        ),
      );
    }
    meta.textContent = "settling: proofs and receipt…";
    const r = await stream.verification;
    answer.result = r;
    testHook().results.push({
      prewarmed: r.prewarmed,
      ttftMs: r.ttftMs,
      totalMs: r.totalMs,
      wallMs: Math.round(performance.now() - t0),
      costMsats: r.costMsats,
      usage: r.ownUsage?.usage,
      receiptSigOk: r.receiptSigOk,
      usageMatch: r.usageMatch,
      costWithinOffer: r.costWithinOffer,
      provider: r.provider && { host: r.provider.host, matched: r.provider.hostnameMatched, leaf: r.provider.chain[0]?.subject, chain: r.provider.chain.length, cipher: r.provider.cipherSuite },
      timings: r.timings,
      textLength: answer.content.length,
    });
    const usage = r.ownUsage?.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    meta.replaceChildren(
      h("span", { class: "check" }, "verified"),
      h("span", {}, r.prewarmed ? "warm" : r.waitedForArmMs !== undefined ? `waited ${(r.waitedForArmMs / 1000).toFixed(1)} s for pre-arm` : "cold"),
      h("span", {}, `first token ${(r.ttftMs / 1000).toFixed(1)} s`),
      h("span", {}, `total ${((performance.now() - t0) / 1000).toFixed(1)} s`),
      h("span", {}, usage ? `${usage.prompt_tokens}/${usage.completion_tokens} tok` : ""),
      h("span", {}, formatSats(r.costMsats ?? 0)),
      h("button", { type: "button", onclick: () => showDetails(answer) }, "details"),
    );
    selectTurn(answer);
  } catch (err) {
    const msg = friendlyError(err);
    answer.error = msg;
    testHook().errors.push(msg);
    answer.el.classList.add("error");
    if (!answer.content) body.textContent = "";
    meta.replaceChildren(h("span", { class: "cross" }, msg), h("button", { type: "button", onclick: () => showDetails(answer) }, "details"));
    selectTurn(answer);
  } finally {
    busy = false;
    $<HTMLButtonElement>("send").disabled = false;
    void refreshBalance();
    idle();
  }
}

function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (err instanceof SessionRejectedError) {
    if (err.status === 402) return `Not enough balance for this request's reservation (${raw}). Top up, or lower max tokens.`;
    if (err.status === 429) return "The node already holds 3 unused sessions for your address (other tabs or devices behind the same IP). Close them or wait a few minutes.";
    if (err.status === 409) return `The node's signed offer changed (prices or fees); reload to accept the new one. (${raw})`;
    if (err.status === 401) return `The node does not know this key (${raw}).`;
  }
  return raw;
}

/** Non-secret outcomes for the browser tests (no credential, no prompt). */
function testHook(): { results: unknown[]; errors: string[]; renderMarkdown?: (t: string) => string } {
  const w = window as unknown as { __rc?: { results: unknown[]; errors: string[]; renderMarkdown?: (t: string) => string } };
  w.__rc ??= { results: [], errors: [], renderMarkdown, waterfall, reencode, client: () => client } as never;
  return w.__rc;
}

// ─── image mode ─────────────────────────────────────────────────────────────
// Confidential image generation: one cold session per request (never
// pre-armed), flat-priced at the signed offer's per-image price. The prompt
// and the aspect ratio stay private; the node sees the model, the resolution
// tier and the count it charges for.

const ASPECTS = ["16:9", "4:3", "1:1"];
const PREFERRED_IMAGE_MODEL = "qwen-image-2-1-turbo";
/** Protocol data per image (2PC ~22 MB down, ~1.2 MB up, proofs), before the image itself. */
const SETUP_MB_PER_IMAGE = 26;
let galleryLoaded = false;
let imageBodySent = false;

function imagesOffer(): ConfidentialImagesOffer | undefined {
  return offer ? offerImages(offer) : undefined;
}

function imageControls(): Child[] {
  const sel = (id: string, onchange: () => void) => h("select", { id, onchange });
  return [
    h("label", { class: "inline" }, "model", sel("img-model", onImageModelChange)),
    h(
      "label",
      { class: "inline", id: "img-variant-label" },
      "resolution",
      sel("img-variant", () => {
        save(K.imgVariant, $<HTMLSelectElement>("img-variant").value);
        renderImageEstimate();
      }),
    ),
    h(
      "label",
      { class: "inline", title: "Private: sent inside the encrypted request, the node does not see it" },
      "aspect",
      h(
        "select",
        { id: "img-aspect", onchange: (e: Event) => save(K.imgAspect, (e.target as HTMLSelectElement).value) },
        ...ASPECTS.map((a) => h("option", { value: a, selected: a === load(K.imgAspect, "16:9") }, a)),
      ),
    ),
    h(
      "label",
      { class: "inline", title: "Images in one request (one confidential session)" },
      "images",
      sel("img-count", () => {
        save(K.imgCount, Number($<HTMLSelectElement>("img-count").value));
        renderImageEstimate();
      }),
    ),
    h("span", { class: "est", id: "img-estimate" }),
  ];
}

function cheapest(variants: ConfidentialImageVariant[]): number {
  return Math.min(...variants.map((v) => v.msat_per_image));
}

/** Fill the image controls from the signed offer. */
function renderImageControls(): void {
  const im = imagesOffer();
  const modelSel = document.getElementById("img-model") as HTMLSelectElement | null;
  if (!modelSel) return;
  const models = im ? Object.keys(im.price_list).sort((a, b) => cheapest(im.price_list[a]!) - cheapest(im.price_list[b]!) || a.localeCompare(b)) : [];
  const saved = load<string>(K.imgModel, "");
  const want = [saved, PREFERRED_IMAGE_MODEL].find((m) => m && models.includes(m)) ?? models[0] ?? "";
  modelSel.replaceChildren(
    ...models.map((m) => h("option", { value: m, selected: m === want }, `${m} · ${formatSats(cheapest(im!.price_list[m]!))}`)),
  );
  const countSel = $<HTMLSelectElement>("img-count");
  const max = im?.max_count ?? 1;
  const savedCount = Math.min(load<number>(K.imgCount, 1), max);
  countSel.replaceChildren(...Array.from({ length: max }, (_, i) => h("option", { value: i + 1, selected: i + 1 === savedCount }, String(i + 1))));
  onImageModelChange();
}

function onImageModelChange(): void {
  const im = imagesOffer();
  const model = (document.getElementById("img-model") as HTMLSelectElement | null)?.value ?? "";
  if (model) save(K.imgModel, model);
  const variants = im?.price_list[model] ?? [];
  const saved = load<string>(K.imgVariant, "");
  const sel = $<HTMLSelectElement>("img-variant");
  sel.replaceChildren(
    ...variants.map((v) => h("option", { value: v.id, selected: v.id === saved }, `${v.id} · ${formatSats(v.msat_per_image)}`)),
  );
  $("img-variant-label").hidden = variants.length <= 1;
  renderImageEstimate();
}

function imageChoice(): { model: string; variant: ConfidentialImageVariant; count: number; aspect: string } | undefined {
  const im = imagesOffer();
  const model = (document.getElementById("img-model") as HTMLSelectElement | null)?.value ?? "";
  const variants = im?.price_list[model];
  if (!variants?.length) return undefined;
  const id = $<HTMLSelectElement>("img-variant").value;
  const variant = variants.find((v) => v.id === id) ?? variants[0]!;
  const count = Math.max(1, Number($<HTMLSelectElement>("img-count").value) || 1);
  return { model, variant, count, aspect: $<HTMLSelectElement>("img-aspect").value || "16:9" };
}

function renderImageEstimate(): void {
  const el = document.getElementById("img-estimate");
  if (!el) return;
  if (!imagesOffer()) {
    el.textContent = offer ? "This node does not offer confidential image generation." : "";
    return;
  }
  const c = imageChoice();
  if (!c) return;
  const fee = offerSessionFeeMsat(offer!);
  const total = c.variant.msat_per_image * c.count + fee;
  const abandon = offerAbandonFeeMsat(offer!);
  el.textContent =
    `${formatSats(c.variant.msat_per_image)} per image · ${formatSats(total)} for ${c.count}` +
    (fee ? ` (incl. session fee ${formatSats(fee)})` : "") +
    ` · about ${SETUP_MB_PER_IMAGE} MB of setup data per request (no pre-warm: each request sets up its own session)` +
    (abandon ? ` · cancelled before sending: ${formatSats(abandon)}` : "");
}

function setMode(m: "chat" | "image"): void {
  if (busy) return toast("Wait for the current request to finish");
  mode = m;
  save(K.mode, m);
  applyMode();
}

function applyMode(): void {
  const image = mode === "image";
  $("chat-controls").hidden = image;
  $("image-controls").hidden = !image;
  $("messages").hidden = image;
  $("gallery").hidden = !image;
  $("mode-chat").setAttribute("aria-pressed", String(!image));
  $("mode-image").setAttribute("aria-pressed", String(image));
  $<HTMLTextAreaElement>("prompt").placeholder = image
    ? "Describe the image. The node relays it encrypted; it sees only the model, resolution and count it charges for."
    : "Ask something. The node relays it encrypted; only the provider and you can read it.";
  $("send").textContent = image ? "Generate" : "Send";
  if (image && !galleryLoaded) void loadGallery();
  if (image) renderImageEstimate();
}

async function loadGallery(): Promise<void> {
  galleryLoaded = true;
  const g = $("gallery");
  const stored = await listImages();
  if (!stored.length) {
    g.replaceChildren(h("div", { class: "empty", id: "gallery-empty" }, h("p", {}, "Images you generate appear here. They are kept only in this browser."), h("p", { class: "muted" }, "Each request is a confidential session of its own: the provider receives your prompt encrypted end to end, and the node charges the signed flat price.")));
    return;
  }
  g.replaceChildren(...stored.map((img) => imageTile(img)));
}

function imageTile(img: StoredImage, result?: ConfidentialSessionResult): HTMLElement {
  const url = URL.createObjectURL(img.blob);
  const tile: HTMLElement = h(
    "figure",
    { class: "image-tile" },
    h("a", { href: url, target: "_blank", rel: "noopener", title: "Open full size" }, h("img", { src: url, alt: img.prompt, loading: "lazy" })),
    h(
      "figcaption",
      {},
      h("div", {}, img.prompt),
      h(
        "div",
        { class: "meta" },
        h("span", {}, `${img.model} · ${img.variant}`),
        h("span", {}, formatSats(img.costMsats)),
        h("span", {}, `${Math.round(img.blob.size / 1024)} KB`),
        h("a", { href: url, download: `image-${img.created}.${img.blob.type === "image/jpeg" ? "jpg" : "webp"}` }, "download"),
        result ? h("button", { type: "button", onclick: () => showImageDetails(tile, result) }, "details") : null,
        h(
          "button",
          {
            type: "button",
            onclick: async () => {
              if (img.id !== undefined) await deleteImage(img.id);
              URL.revokeObjectURL(url);
              tile.remove();
            },
          },
          "delete",
        ),
      ),
    ),
  );
  return tile;
}

function showImageDetails(el: HTMLElement, result: ConfidentialSessionResult): void {
  selected = { role: "assistant", content: "", el, result };
  renderSide();
  document.getElementById("verification")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** On a metered connection, say once what an image request costs in data. */
function meteredOk(): boolean {
  const c = (navigator as unknown as { connection?: { saveData?: boolean; type?: string; effectiveType?: string } }).connection;
  const metered = !!c && (c.saveData === true || c.type === "cellular" || /(^|-)(2g|3g)$/.test(c.effectiveType ?? ""));
  if (!metered || load(K.meteredWarned, false)) return true;
  save(K.meteredWarned, true);
  return confirm(
    `Each confidential image request moves about ${SETUP_MB_PER_IMAGE} MB of setup data (the two-party handshake and the proofs) before the image itself. Continue on this connection?`,
  );
}

const IMAGE_STAGES: Record<string, string> = {
  request: "starting a confidential session…",
  ready: "secure setup: the node checked the key and reserved the price…",
  twopc_key_share: "secure setup done (2PC key share); TLS handshake with the provider…",
  hs_verified: "provider certificate and handshake verified; proving the node's key record…",
  pi_nk_ok: "node's key record proven; writing the request…",
  head_written: "request head written; sending the encrypted prompt…",
  body_sent: "request sent; waiting for the provider…",
  pi_c2s_ok: "pinned price parameters proven; waiting for the image…",
  attestation: "verifying the response and the node's attestation…",
};

function imageProgressEvent(e: Record<string, unknown>): void {
  if (e.ev === "body_sent") imageBodySent = true;
  if (!imageProgress) return;
  if (e.ev === "response_progress" && typeof e.bytes === "number") {
    imageProgress.textContent = `downloading the image (${(e.bytes / 1e6).toFixed(1)} MB)…`;
    return;
  }
  const text = IMAGE_STAGES[String(e.ev)];
  if (text) imageProgress.textContent = text;
}

async function onSendImage(): Promise<void> {
  if (busy || !client) return;
  const ta = $<HTMLTextAreaElement>("prompt");
  const prompt = ta.value.trim();
  if (!prompt) return;
  if (!credential) return toast("Fund the wallet first (Lightning or Cashu)");
  if (!imagesOffer()) return toast("This node does not offer confidential image generation");
  const c = imageChoice();
  if (!c) return toast("No image model available");
  if (!meteredOk()) return;
  document.getElementById("gallery-empty")?.remove();
  const progress = h("div", { class: "meta" }, "starting a confidential session…");
  const ctrl = new AbortController();
  const fee = offerAbandonFeeMsat(offer!);
  const cancel = h(
    "button",
    {
      type: "button",
      onclick: () => {
        ctrl.abort();
        progress.textContent = imageBodySent
          ? "Cancelled after the request reached the provider: it is charged."
          : `Cancelled before the request was sent: the reservation is released${fee ? ` (less the unused-session fee ${formatSats(fee)})` : ""}.`;
      },
    },
    "cancel",
  );
  const card = h("div", { class: "msg assistant image-pending" }, h("div", {}, prompt), progress, cancel);
  $("gallery").prepend(card);
  imageProgress = progress;
  imageBodySent = false;
  busy = true;
  $<HTMLButtonElement>("send").disabled = true;
  const t0 = performance.now();
  try {
    const out = await client.images.generate(
      { model: c.model, prompt, count: c.count, variant: c.variant.id, aspectRatio: c.aspect },
      { signal: ctrl.signal },
    );
    ta.value = "";
    imageProgress = undefined;
    const tiles: HTMLElement[] = [];
    for (const blob of out.images) {
      const small = await reencode(blob);
      const img: StoredImage = {
        created: Date.now(),
        prompt,
        model: out.model,
        variant: out.variant,
        costMsats: Math.round(out.costMsats / Math.max(1, out.images.length)),
        sid: out.confidential.sid,
        receiptJson: out.confidential.receiptJson,
        blob: small,
      };
      img.id = await putImage(img);
      tiles.push(imageTile(img, out.confidential));
    }
    // Only the re-encoded copies are kept: the provider's full-size images
    // would otherwise stay alive through the session result the tiles hold.
    const received = out.images.length;
    out.images.length = 0;
    testHook().results.push({
      kind: "images",
      model: out.model,
      variant: out.variant,
      count: out.count,
      images: received,
      costMsats: out.costMsats,
      receiptSigOk: out.confidential.receiptSigOk,
      wallMs: Math.round(performance.now() - t0),
    });
    card.replaceWith(...tiles);
    if (tiles[0]) showImageDetails(tiles[0], out.confidential);
  } catch (err) {
    imageProgress = undefined;
    if (ctrl.signal.aborted) {
      cancel.remove();
    } else {
      const msg =
        err instanceof UpstreamImageError
          ? `The provider refused the request (HTTP ${err.status}). The receipt verified; a refusal costs at most the session fee.`
          : friendlyError(err);
      testHook().errors.push(msg);
      card.classList.add("error");
      const details =
        err instanceof UpstreamImageError
          ? h("button", { type: "button", onclick: () => showImageDetails(card, err.result as ConfidentialSessionResult) }, "details")
          : null;
      progress.replaceChildren(h("span", { class: "cross" }, msg));
      cancel.replaceWith(...(details ? [details] : []));
    }
  } finally {
    busy = false;
    $<HTMLButtonElement>("send").disabled = false;
    void refreshBalance();
    idle();
  }
}

// ─── settings / boot ────────────────────────────────────────────────────────

function onSaveSettings(): void {
  settings.node = $<HTMLInputElement>("set-node").value.trim().replace(/\/$/, "");
  settings.pubkey = $<HTMLInputElement>("set-pubkey").value.trim();
  settings.trustedHost = $<HTMLInputElement>("set-host").value.trim();
  save(K.settings, settings);
  void restart();
}

async function restart(): Promise<void> {
  offer = undefined;
  offerError = undefined;
  pricing = [];
  makeClient();
  renderStatus();
  renderSide();
  try {
    offer = await client!.offer();
    pricing = await client!.pricing(maxTokens());
    renderModels();
    renderImageControls();
    void mintInputFees(offer.mints ?? []).then((f) => {
      mintFees = f;
      renderSide();
    });
  } catch (e) {
    offerError = e instanceof Error ? e.message : String(e);
  }
  renderStatus();
  renderSide();
  await refreshBalance();
  const p = currentModel();
  if (p) client?.prepare(p.id, maxTokens());
}

window.addEventListener("beforeunload", (e) => {
  if (credential && !remember && balance && balance.balance > 0) {
    e.preventDefault();
  }
});

testHook();
layout();
renderSide();
setupPwa({ isBusy: () => busy, toast });
void restart();
setInterval(() => void refreshBalance(), 60_000);

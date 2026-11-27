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
  NodeProtocolOutdatedError,
  UpgradeRequiredError,
  RequestRefusedError,
  ConnectionDepositError,
  StreamNotProcessedError,
  PoolBusyError,
  ReservationAboveCeilingError,
  mayHaveReachedProvider,
  CONFIDENTIAL_ERROR_CODES,
  TwoPcVersionMismatchError,
  offerConnectionDepositMsat,
  reservationMsat,
  offerImages,
  type ConfidentialImagesOffer,
  type ConfidentialImageVariant,
  type MintFee,
  roughTokens,
  costMsat,
  type BalanceInfo,
  type ConfidentialClient,
  type ConfidentialStream,
  type ConfidentialSessionResult,
  type ModelPricing,
  type VerifiedOffer,
  type ConfidentialFraming,
} from "@routstr/confidential-web";
import { APP_BUILD, APP_VERSION, idle, setupPwa } from "./pwa";
import { deleteImage, listImages, putImage, reencode, type StoredImage } from "./imagestore";
import { bolt11AmountMsat } from "./bolt11";

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
  /** Legacy single key (migrated to `credentials`). */
  credential: "rc:credential",
  /** Remembered keys, per node URL. */
  credentials: "rc:credentials",
  model: "rc:model",
  maxTokens: "rc:max-tokens",
  prewarm: "rc:prewarm",
  /** The framing towards the provider: "auto", "2" (HTTP/2) or "1.1" (HTTP/2 off). */
  http: "rc:http",
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

/** Tab-scoped state (sessionStorage): it survives a reload of this tab, nothing else. */
const SK = {
  /** In-memory wallet state written right before an automatic update reload, restored (and removed) at boot. */
  stash: "rc:reload-stash",
  /** Lightning invoices still waiting for payment. */
  invoices: "rc:invoices",
  /** The conversation's text, written right before an automatic update reload, restored (and removed) at boot. */
  turns: "rc:reload-turns",
};
function sload<T>(k: string, d: T): T {
  try {
    const v = sessionStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
}
function ssave(k: string, v: unknown): void {
  try {
    if (v === undefined) sessionStorage.removeItem(k);
    else sessionStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}
function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) if (typeof x === "string" && x) out[k] = x;
  }
  return out;
}

const settings = load(K.settings, { ...DEFAULTS });
/**
 * The keys this tab holds, per node URL. A key is a bearer credential for the
 * node that issued it, so it is only ever sent to that node: changing the
 * node URL switches to the key kept for the new node (or none).
 */
const nodeKeys: Record<string, string> = stringMap(load<unknown>(K.credentials, {}));
// Earlier versions kept a single key for whichever node was configured.
const legacyKey = load<string | undefined>(K.credential, undefined);
if (typeof legacyKey === "string" && legacyKey && !nodeKeys[settings.node]) nodeKeys[settings.node] = legacyKey;
// Off by default: the key is a bearer credential, and local storage is
// readable by any script this origin serves. A key kept only in memory is
// lost with the tab, so the page asks the user to copy it and warns before
// closing a funded tab. An install that already stored a key before this
// default changed keeps it until the user unticks the box.
let remember = load<boolean>(K.remember, Object.keys(nodeKeys).length > 0);
function persistKeys(): void {
  save(K.credentials, remember && Object.keys(nodeKeys).length ? nodeKeys : undefined);
}
if (legacyKey !== undefined) {
  save(K.credential, undefined);
  persistKeys();
}

/** A paid Lightning invoice whose key differs from the key in use: shown, never swapped in silently. */
interface KeyOffer {
  node: string;
  key: string;
  amountSats: number;
}
/** A Cashu token from Withdraw, shown until the user says it is saved. */
let refundToken: string | undefined;
let keyOffers: KeyOffer[] = [];
/** Set once an automatic reload has stashed the state: the unload guard then stays quiet. */
let autoReloading = false;
/** The conversation an automatic update reload stashed (text only), shown again once at boot. */
let restoredTurns: { role: "user" | "assistant"; content: string }[] = [];
/** Largest conversation kept over an update reload (the newest turns, text only). */
const STASH_TURNS_BYTES = 1024 * 1024;
// Restore what the last automatic update reload stashed, then drop the stash.
{
  const kept = sload<unknown>(SK.turns, undefined);
  ssave(SK.turns, undefined);
  if (Array.isArray(kept)) {
    restoredTurns = kept.filter(
      (t): t is { role: "user" | "assistant"; content: string } =>
        !!t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.length > 0,
    );
  }
  const s = sload<{ keys?: unknown; refundToken?: unknown; keyOffers?: unknown } | undefined>(SK.stash, undefined);
  ssave(SK.stash, undefined);
  if (s && typeof s === "object") {
    for (const [n, k] of Object.entries(stringMap(s.keys))) nodeKeys[n] ??= k;
    if (typeof s.refundToken === "string" && s.refundToken) refundToken = s.refundToken;
    if (Array.isArray(s.keyOffers)) {
      keyOffers = s.keyOffers.filter(
        (o): o is KeyOffer => !!o && typeof o.node === "string" && typeof o.key === "string" && typeof o.amountSats === "number",
      );
    }
  }
}
/** Before an automatic update reload: keep in this tab what lives only in memory. */
function stashForReload(): void {
  autoReloading = true;
  ssave(SK.stash, { keys: nodeKeys, refundToken, keyOffers });
  // Separate from the wallet state: a conversation too large for the tab's
  // storage must not cost the keys.
  const t = stashTurns();
  if (t.length) ssave(SK.turns, t);
}

/**
 * The conversation's text for the reload: the newest turns up to 1 MB,
 * without attached images or failed answers. Only this tab's
 * sessionStorage holds it, for the reload.
 */
function stashTurns(): { role: "user" | "assistant"; content: string }[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  let bytes = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.error || !t.content) continue;
    bytes += t.content.length * 2 + 32;
    if (bytes > STASH_TURNS_BYTES) break;
    out.unshift({ role: t.role, content: t.content });
  }
  return out;
}

/** Show the conversation the update reload kept (once). */
function restoreTurns(): void {
  if (!restoredTurns.length) return;
  for (const t of restoredTurns) addTurn(t.role, t.content);
  restoredTurns = [];
}
/** The node whose key `credential` is (the one the client talks to). */
let activeNode = settings.node;
let credential: string | undefined = nodeKeys[activeNode];
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
// Off by default: on HTTP/2 the open connection stays warm between messages; a prepared
// connection only helps after it idled out, and costs its deposit if never used.
const prewarmParam = new URLSearchParams(location.search).get("prewarm");
let prewarmOn = prewarmParam === "0" ? false : prewarmParam === "1" ? true : load(K.prewarm, false);
type HttpSetting = "auto" | ConfidentialFraming;
const HTTP_SETTINGS: HttpSetting[] = ["auto", "2", "1.1"];
/** `?http=1.1` (tests) or the user's choice in the Node panel. */
let httpSetting: HttpSetting = ((): HttpSetting => {
  const q = new URLSearchParams(location.search).get("http");
  const v = (HTTP_SETTINGS as string[]).includes(q ?? "") ? q : load<string>(K.http, "auto");
  return (HTTP_SETTINGS as string[]).includes(v ?? "") ? (v as HttpSetting) : "auto";
})();
/** The framing the next chat request uses (from the setting, the signed offer and a fallback in force). */
let nextFraming: ConfidentialFraming | undefined;
/** The node's offer names an older protocol (node_protocol_outdated): its version. */
let outdatedNode: number | undefined;
/** The deposit outcome of each connection, as the node reported it (connection id → text). */
const depositOutcomes = new Map<string, { msat: number; outcome: string; reason: string; signed: boolean }>();
let mintFees: MintFee[] | undefined;
/** Deposit outcomes the library flagged as not matching the rules (shown in the wallet until dismissed). */
const depositWarnings: string[] = [];

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
  /** Attached images (data URIs), sent with this turn on every later request. */
  images?: string[];
  el: HTMLElement;
  result?: ConfidentialSessionResult;
  error?: string;
  /** The technical text behind `error`. */
  errorDetail?: string;
  meta?: HTMLElement;
}

let client: ConfidentialClient | undefined;
let api = new NodeApi(settings.node);
let offer: VerifiedOffer | undefined;
let offerError: string | undefined;
/** The technical text behind `offerError`. */
let offerErrorDetail: string | undefined;
let pricing: ModelPricing[] = [];
let balance: BalanceInfo | undefined;
let busy = false;
let selected: Turn | undefined;
const turns: Turn[] = [];
/** Images attached to the next message (data URIs, prepared by prepareImage). */
let attachments: string[] = [];
/** Models whose node entry lists image input; undefined while unknown (then any model may try). */
let visionModels: Set<string> | undefined;
const events: string[] = [];
let prewarmStatus = "off";
/** Chat, or confidential image generation (on demand only, never pre-armed). */
let mode: "chat" | "image" = load<"chat" | "image">(K.mode, "chat");
/** The progress line of the request in flight (chat until its answer starts, or an image request). */
type Progress = { kind: "chat" | "images"; text: HTMLElement; bar: HTMLProgressElement };
let activeProgress: Progress | undefined;

function logEvent(e: Record<string, unknown>): void {
  const { t, ...rest } = e;
  const line = `${new Date(Number(t) || Date.now()).toLocaleTimeString()} ${JSON.stringify(rest)}`;
  events.push(line);
  if (events.length > 300) events.shift();
  if (e.kind === "images" && e.ev === "pi_win_ok") imageBodySent = true;
  if (activeProgress && (e.kind === "images") === (activeProgress.kind === "images")) progressEvent(activeProgress, e);
  if (e.ev === "prewarm" && typeof e.status === "string") {
    prewarmStatus = e.status;
    renderStatus();
  }
  if (e.ev === "deposit" && typeof e.sid === "string") {
    depositOutcomes.set(e.sid, { msat: Number(e.msat), outcome: String(e.outcome), reason: String(e.reason), signed: e.signed === true });
    if (e.outcome === "charged") toast(`A connection ended unused: the node kept its ${formatSats(Number(e.msat))} deposit (${String(e.reason)}).`, 8000);
    void refreshBalance();
  }
  if (e.ev === "warning" && e.code === "deposit_outcome") {
    const text = `The node's report on a connection deposit did not match the rules: ${String(e.message ?? "no detail")}. Check your balance; if money is missing, use another node.`;
    depositWarnings.push(text);
    toast(text, 12000);
    renderDepositWarnings();
  }
  if (e.ev === "framing_fallback") {
    toast("HTTP/2 to the provider failed to open on this node: using HTTP/1.1 for 10 minutes.", 8000);
    void updateFraming();
  }
  if (e.ev === "pool" || e.ev === "request_settled") renderConnections();
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
    http: httpSetting,
    prewarm: { enabled: prewarmOn },
    onEvent: logEvent,
  });
}

/** The framing the next chat request would use (shown in the header). */
async function updateFraming(): Promise<void> {
  try {
    nextFraming = client && offer ? await client.framing("chat") : undefined;
  } catch {
    nextFraming = undefined;
  }
  renderStatus();
}

const FRAMING_LABEL: Record<ConfidentialFraming, string> = { "2": "HTTP/2", "1.1": "HTTP/1.1" };

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
        h("span", { class: "pill", id: "warm-pill", title: "Pre-warmed (armed) connection" }, "pre-warm: off"),
        h("span", { class: "pill", id: "http-pill", title: "HTTP to the provider (setting in the Node panel)" }, "HTTP: …"),
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
          h("div", { class: "warnbox proto-banner", id: "proto-banner", hidden: true, role: "alert" }),
          h("div", { class: "messages", id: "messages" }, emptyState()),
          h("div", { class: "messages gallery", id: "gallery" }),
          h("div", { class: "attachments", id: "attachments", hidden: true }),
          h(
            "form",
            { class: "composer", onsubmit: onSend },
            h("input", {
              type: "file",
              id: "attach-input",
              accept: "image/png,image/jpeg,image/webp,image/gif",
              multiple: true,
              hidden: true,
              onchange: (e: Event) => {
                const input = e.target as HTMLInputElement;
                void addAttachments([...(input.files ?? [])]);
                input.value = "";
              },
            }),
            h(
              "button",
              { type: "button", id: "attach", class: "secondary", title: "Attach an image (models that accept image input)", onclick: () => $("attach-input").click() },
              "Image",
            ),
            h("textarea", {
              id: "prompt",
              rows: 2,
              placeholder: "Ask something. The node relays it encrypted; only the provider and you can read it.",
              // Typing an image prompt must not arm a chat session.
              oninput: () => {
                if (mode === "chat") client?.activity();
                renderEstimate();
              },
              onpaste: (e: ClipboardEvent) => {
                if (mode !== "chat") return;
                const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
                if (!files.length) return;
                e.preventDefault();
                void addAttachments(files);
              },
              // Typing is activity; focus is not (it fires again when the tab
              // returns, which must not re-arm a session by itself).
              onkeydown: (e: KeyboardEvent) => {
                if (mode === "chat") client?.activity();
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

function depositWarningBoxes(): HTMLElement[] {
  return depositWarnings.map((text, i) =>
    h(
      "div",
      { class: "warnbox deposit-warning" },
      h("p", {}, text),
      h("button", { type: "button", class: "secondary", onclick: () => { depositWarnings.splice(i, 1); renderDepositWarnings(); } }, "Dismiss"),
    ),
  );
}

function renderDepositWarnings(): void {
  document.getElementById("deposit-warnings")?.replaceChildren(...depositWarningBoxes());
}

function walletCard(): HTMLElement {
  const card = h("div", { class: "card" });
  card.append(
    h("div", { id: "deposit-warnings" }, ...depositWarningBoxes()),
    h("div", { id: "refund-token" }, ...refundTokenBox()),
    h("div", { id: "key-offers" }, ...keyOfferBoxes()),
  );
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
              persistKeys();
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
    const others = Object.keys(nodeKeys).filter((n) => n !== settings.node);
    if (others.length) {
      card.append(
        h("p", { class: "muted" }, `No key for this node. Keys for other nodes (${others.map(hostOf).join(", ")}) stay with those nodes and are never sent here.`),
      );
    }
  }
  card.append(
    h(
      "div",
      { class: "row" },
      h("input", { id: "ln-amount", type: "number", min: 1, value: "500", "aria-label": "Amount in sats" }),
      h("button", { type: "button", onclick: onLightning }, "Lightning"),
    ),
    h("div", { id: "invoice" }, ...invoiceBoxes()),
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
        h("button", { type: "button", id: "refund-btn", onclick: onRefund }, "Withdraw"),
        h("div", { id: "refund-out" }),
      ),
    );
  }
  return card;
}

/** How long the node keeps an idle connection, in words ("2 minutes", "90 seconds"). */
function idleText(o: VerifiedOffer): string {
  const s = typeof o.idle_timeout_s === "number" && o.idle_timeout_s > 0 ? o.idle_timeout_s : 120;
  if (s % 60 === 0) return s === 60 ? "1 minute" : `${s / 60} minutes`;
  return s > 90 ? `about ${Math.round(s / 60)} minutes` : `${s} seconds`;
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
  const deposit = offerConnectionDepositMsat(offer);
  const pct = typeof offer.rate_surcharge_pct === "number" ? offer.rate_surcharge_pct : 0;
  card.append(
    h(
      "p",
      {},
      h("strong", {}, "Prices: "),
      "the line under the model shows the selected model's signed rates, a typical message's cost and the balance it needs. ",
      "You pay the provider-reported usage at those rates",
      sessionFee ? `, plus a session fee of ${formatSats(sessionFee)} once per connection` : "",
      pct ? ` (rates include a ${pct}% confidential surcharge)` : "",
      ". While a request runs, the node holds its worst case (a prompt filling the model's whole context plus the max tokens",
      abandon || sessionFee ? `, plus the ${formatSats(Math.max(abandon, sessionFee))} fee` : "",
      ") and releases the rest when it settles. Each answer shows its exact cost from the signed receipt.",
    ),
    h(
      "p",
      {},
      h("strong", {}, "Data: "),
      "a message that opens a new connection first downloads about 18 MB of setup data (the two-party setup and the proofs); later messages on an open connection need little.",
    ),
    h(
      "p",
      {},
      h("strong", {}, "Connection deposit: "),
      deposit
        ? `opening a connection reserves ${formatSats(deposit)}; the connection's first answer releases it (the receipt says so). A connection that ends without an answer (for example one prepared ahead and never used) loses it, unless the node or the provider failed.`
        : "this node takes none.",
    ),
    h(
      "p",
      {},
      h("strong", {}, "Pre-warming: "),
      deposit > 0
        ? `off by default, because on HTTP/2 the open connection already stays warm between messages (for ${idleText(offer)} of idle). Turned on, after your first message the app also keeps a connection prepared (its two-party setup done), so the answer after a longer pause starts faster. It costs nothing if you use it; one you never use costs its ${formatSats(deposit)} deposit. It is only prepared while this page is visible and you have funds for the deposit and one message.`
        : "after your first message, keeping a connection prepared makes the next answer faster when no connection is open, and costs nothing extra. It is only prepared while this page is visible and you have funds.",
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
      "Keep a connection prepared (pre-warm)",
    ),
  );
  if (deposit > 5000) card.append(h("p", { class: "warnbox" }, "This node's connection deposit is above 5 sats, so the app does not pre-warm."));
  void abandon;
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
        ? `${paid.map((m) => `${hostOf(m.mint)} ${m.inputFeePpk} ppk`).join(", ")} — that is about ${Math.ceil((paid[0]!.inputFeePpk ?? 0) / 1000)} sat per proof batch of up to ${Math.floor(1000 / Math.max(1, paid[0]!.inputFeePpk ?? 1))} proofs, rounded up.`
        : "the node's mints charge none.",
      ` Mints this node accepts: ${offerMints().map(hostOf).join(", ") || "—"}.`,
    ),
  );
}

function currentModelOrNull(): ModelPricing | undefined {
  return pricing.find((p) => p.id === modelPicker.value);
}

function balanceSub(avail?: number): string {
  return balance
    ? `${formatSats(avail ?? 0)} available · ${formatSats(balance.reserved)} reserved (requests in flight, connection deposits)`
    : "loading balance";
}

/** The page's connections to the node (no credentials): framing, state, requests. */
function connectionLines(): HTMLElement[] {
  const list = client?.connections() ?? [];
  if (!list.length) return [h("p", { class: "muted" }, "No open connection.")];
  return [
    h(
      "p",
      { class: "muted" },
      "Connections: ",
      list
        .map((c) => `${c.sid ? c.sid.slice(0, 8) : "…"} ${FRAMING_LABEL[c.http]} ${c.state}${c.requests ? `, ${c.requests} request${c.requests > 1 ? "s" : ""}` : ""}`)
        .join(" · "),
    ),
  ];
}

function renderConnections(): void {
  document.getElementById("conns")?.replaceChildren(...connectionLines());
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
      { class: "field" },
      "HTTP to the provider",
      h(
        "select",
        {
          id: "set-http",
          onchange: (e: Event) => {
            httpSetting = (e.target as HTMLSelectElement).value as HttpSetting;
            save(K.http, httpSetting);
            client?.setHttp(httpSetting);
            void updateFraming();
            toast(httpSetting === "1.1" ? "HTTP/2 is off: every message opens its own connection." : httpSetting === "2" ? "HTTP/2 only." : "HTTP: the node's choice (HTTP/2 when offered).");
          },
        },
        h("option", { value: "auto", selected: httpSetting === "auto" }, "auto (HTTP/2 when the node offers it)"),
        h("option", { value: "2", selected: httpSetting === "2" }, "HTTP/2 only"),
        h("option", { value: "1.1", selected: httpSetting === "1.1" }, "HTTP/1.1 (HTTP/2 off)"),
      ),
    ),
    h(
      "p",
      { class: "muted" },
      "With HTTP/2 one connection to the provider, and one two-party handshake, serves your next messages: faster, and the provider can tell they come from one client (as it can for one API key). HTTP/1.1 opens a connection per message.",
    ),
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
          ["protocol", `v${offer.v} (connections; two-party key schedule ${offer.twopc ?? "?"})`],
          ["framings", (offer.http ?? ["1.1"]).map((f) => FRAMING_LABEL[f as ConfidentialFraming] ?? f).join(", ") + (offer.h2 ? ` · up to ${offer.h2.max_requests} requests per HTTP/2 connection` : "")],
          ["connection deposit", offerConnectionDepositMsat(offer) ? formatSats(offerConnectionDepositMsat(offer)) : "none"],
          ["idle connection closed after", `${offer.idle_timeout_s ?? 120} s`],
          ["session fee", offer.session_fee_msat ? `${formatSats(offer.session_fee_msat)} once per connection` : "none"],
        ])
      : offerError
        ? errorBox(offerError, offerErrorDetail)
        : h("p", { class: "muted" }, "loading offer…"),
    h("div", { id: "conns" }, ...connectionLines()),
  );
}

/** What the request found: a kept connection, an armed one, or a new one. */
function connectionLabel(r: ConfidentialSessionResult): string {
  return r.connection === "reused" ? "kept connection" : r.connection === "armed" ? "prepared connection" : "new connection";
}

/** The connection deposit as this request saw it, and what became of it. */
function depositText(r: ConfidentialSessionResult): string {
  const d = r.deposit;
  if (!d.msat) return "none (the node takes no deposit)";
  if (d.releasedMsat !== undefined) return `${formatSats(d.releasedMsat)} released by this answer (the connection's first)`;
  if (d.outcome?.reason === "request_settled") return `${formatSats(d.msat)} released earlier, by this connection's first answer`;
  const later = depositOutcomes.get(r.sid);
  if (later) return `${formatSats(later.msat)} ${later.outcome} (${later.reason})${later.signed ? ", signed by the node" : ""}`;
  return `${formatSats(d.msat)}, released by this connection's first answer`;
}

/** A plain error sentence, with the technical text under "details". */
function errorBox(text: string, detail?: string): HTMLElement {
  return h(
    "div",
    {},
    h("span", { class: "cross" }, text),
    detail && detail !== text ? h("details", { class: "error-detail" }, h("summary", {}, "details"), h("pre", {}, detail)) : null,
  );
}

function verificationPanel(): HTMLElement {
  const r = selected?.result;
  if (!r) {
    return h(
      "div",
      { class: "card muted" },
      selected?.error ? errorBox(selected.error, selected.errorDetail) : "Send a message to see what your browser verified: the provider's certificate, the proofs, the signed receipt and the timings.",
    );
  }
  const p = r.provider;
  const t = r.timings;
  const usage = r.ownUsage?.usage as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined;
  const rates = offer?.price_list[r.model];
  const fee = offer?.session_fee_msat ?? 0;
  const proofRow = (name: string, label: string) => {
    const x = t.proofs?.[name];
    return [label, x ? check(x.ok, `ok · ${Math.round(x.ms)} ms (${x.via}${x.runs && x.runs > 1 ? `, ${x.runs} runs` : ""})`) : check(false, "not run")] as [string, Child];
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
        r.connection === "reused"
          ? ["2PC handshake", check(true, `ran once for this connection (request ${r.n} on it); no new handshake`)]
          : ["2PC handshake", check(true, `key schedule run jointly · A ${ms(t.twoPcPhaseAMs)} · B ${ms(t.twoPcPhaseBMs)}`)],
        r.connection === "reused"
          ? ["π_NK (node key record)", check(true, "verified when the connection opened")]
          : proofRow("pi_nk", r.framing === "2" ? "π_NK (HTTP/2 connection head)" : "π_NK (node key record)"),
        proofRow("pi_win", "π_WIN (our records: pinned suffix, frames)"),
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
        ["session fee", r.receipt.session_fee_msat ? `${formatSats(Number(r.receipt.session_fee_msat))} (this connection's first answer)` : "not due (paid once per connection)"],
        ["deposit", depositText(r)],
        ["HTTP to the provider", `${FRAMING_LABEL[r.framing]}${r.stream !== undefined ? ` · stream ${r.stream}` : ""}${r.fellBack ? " · fell back from HTTP/2" : ""}${r.provider?.alpn ? ` · ALPN ${r.provider.alpn}` : ""}`],
        ["connection", h("span", {}, h("code", {}, short(r.sid, 8)), ` · request ${r.n} · ${connectionLabel(r)}`)],
      ]),
      h("details", {}, h("summary", {}, "signed receipt JSON"), h("pre", {}, r.receiptJson), h("div", { class: "mono" }, `sig ${r.receiptSig ?? ""}`)),
    ),
    h(
      "div",
      { class: "card timing" },
      h(
        "div",
        { class: "timing-head" },
        h("strong", {}, r.connection === "reused" ? "Timeline (kept connection)" : r.connection === "armed" ? "Timeline (prepared connection)" : "Timeline (new connection)"),
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
        ["arm (setup + 2PC preprocessing)", r.connection === "reused" ? "— (kept connection)" : r.prewarmed ? `${ms(t.armMs)} (before the request)` : ms(t.armMs)],
        ["2PC key share", ms(t.twoPcKeyShareMs)],
        ["handshake (2PC A + B)", ms(t.handshakeMs)],
        ["π_NK", ms(t.piNkMs)],
        ["credential record", ms(t.recordMs)],
        ["provider first byte", ms(t.upstreamTtftMs)],
        ["2PC traffic", t.twoPcBytes ? `${(t.twoPcBytes.sent / 1e6).toFixed(2)} MB up · ${(t.twoPcBytes.recv / 1e6).toFixed(1)} MB down` : "— (kept connection)"],
        ["this request", `${(r.bytes.sent / 1e6).toFixed(2)} MB up · ${(r.bytes.recv / 1e6).toFixed(2)} MB down`],
        ["connection setup", r.setupBytes ? `${(r.setupBytes.sent / 1e6).toFixed(2)} MB up · ${(r.setupBytes.recv / 1e6).toFixed(1)} MB down` : "— (kept connection)"],
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
        `${r.connection === "reused" ? "Kept connection" : r.connection === "armed" ? "Prepared connection" : "New connection"} (${FRAMING_LABEL[r.framing]}) ${r.images ? "image request · first byte" : "request · first token"} ${ms(r.ttftMs)} · total ${ms(r.totalMs)}`,
      ),
      h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: () => dlg.close() }, "✕"),
    ),
    waterfall(t.spans ?? [], { ttftMs: r.ttftMs, numbers: true, large: true }),
    h(
      "p",
      { class: "muted wf-explain" },
      "Time runs left to right; the blue line is when you sent the message. ",
      r.connection === "reused"
        ? `This message ran on a connection kept open from an earlier one (request ${r.n} on it, HTTP/2): no setup, no two-party handshake and no π_NK, only the request, its proofs and the answer. `
        : r.prewarmed
          ? "Everything left of it happened beforehand: the connection was set up and the two-party (2PC) preparation, the large part, ran while you were typing. "
          : "This request had no prepared connection, so the 2PC preparation ran after you sent it. ",
      r.images
        ? "On a new connection: the TLS handshake with the provider, whose keys the browser and the node compute together (2PC phases A and B); π_NK proves the node's credential record matches the published template; the node writes it. Then: π_WIN proves the pinned model, resolution and count (and, on HTTP/2, every frame) before the provider sees them; the provider generates the image (the red dashed line is its first byte) and the browser downloads and decrypts it. No usage proof is needed: the browser accepts the result and the node charges the signed flat price."
        : "On a new connection: the TLS handshake with the provider, whose keys the browser and the node compute together (2PC phases A and B); π_NK proves the node's credential record (HTTP/2: the connection head) matches the published template; the node writes it. Then: π_WIN proves the pinned model and token cap (and, on HTTP/2, every frame) before the provider sees them, the provider answers (the red dashed line is the first token), and π_C3S discloses only the usage for the receipt.",
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
      h("li", {}, "Testing guide (this app, routstrd, the libraries, running a node): ", link("./testing/", "Testing confidential mode")),
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

const PREWARM_LABEL: Record<string, string> = { "waiting-funds": "needs funds", metered: "off (metered)", hidden: "paused", idle: "ready to arm" };

function renderStatus(): void {
  const op = document.getElementById("offer-pill");
  if (op) {
    op.className = `pill ${offer ? "ok" : offerError ? "bad" : ""}`;
    op.textContent = offer ? "offer verified" : outdatedNode !== undefined ? `node outdated (v${outdatedNode})` : offerError ? "offer rejected" : "offer: …";
    op.title = offerError ?? (offer ? `signed by ${offer.notary_pubkey}` : "");
  }
  const wp = document.getElementById("warm-pill");
  if (wp) {
    wp.className = `pill ${prewarmStatus === "armed" ? "ok" : ""}`;
    wp.textContent = `pre-warm: ${PREWARM_LABEL[prewarmStatus] ?? prewarmStatus}`;
    wp.title = prewarmStatus === "metered" ? "Pre-warm is off on a metered connection (Save-Data or cellular)" : "Pre-warmed (armed) connection: the 2PC preparation done ahead";
  }
  const hp = document.getElementById("http-pill");
  if (hp) {
    hp.className = `pill ${nextFraming === "2" ? "ok" : ""}`;
    hp.textContent = nextFraming ? FRAMING_LABEL[nextFraming] : "HTTP: …";
    hp.title =
      nextFraming === "2"
        ? "HTTP/2 to the provider: one connection (one two-party handshake) carries your next messages"
        : nextFraming === "1.1"
          ? httpSetting === "1.1"
            ? "HTTP/2 is off (Node panel): every message opens its own connection"
            : "HTTP/1.1 to the provider: every message opens its own connection"
          : "HTTP to the provider";
  }
  const banner = document.getElementById("proto-banner");
  if (banner) {
    banner.hidden = outdatedNode === undefined;
    banner.textContent =
      outdatedNode === undefined
        ? ""
        : `This node runs an old protocol (routstr-confidential v${outdatedNode}); this app speaks v3. It cannot serve confidential requests until its operator updates it. Pick another node in the Node panel.`;
  }
}

const DEFAULT_MODEL = "deepseek-v4-1-flash-1017-uncensored";
const modelPicker = combobox({ id: "model", ariaLabel: "Model (type to filter)", onPick: () => onModelChange() });

function renderModels(): void {
  const saved = load<string>(K.model, "");
  const want = [saved, DEFAULT_MODEL].find((id) => id && pricing.some((p) => p.id === id)) ?? pricing[0]?.id ?? "";
  renderModelOptions(want);
  renderEstimate();
  renderAttach();
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
  const images = attachments.length + turns.reduce((n, t) => n + (t.images?.length ?? 0), 0);
  const inTok = roughTokens(prompt) + 20 + images * IMAGE_TOKENS_GUESS;
  const mt = maxTokens();
  const typical = costMsat(p.rates, { prompt_tokens: inTok, completion_tokens: Math.min(mt, 300) }, p.sessionFeeMsat);
  const worst = costMsat(p.rates, { prompt_tokens: inTok, completion_tokens: mt }, p.sessionFeeMsat);
  // The node's reservation for this request (the larger context length at the dearer of the
  // input and cache-write rates, plus max tokens and the fee), and a new connection's deposit.
  const resv =
    offer && p.promptLimit !== undefined
      ? reservationMsat(offer, p.rates, { id: p.id, context_length: p.promptLimit }, mt)
      : p.reservationMsat;
  const deposit = p.connectionDepositMsat;
  el.textContent =
    `≈ ${formatSats(typical)} per message (≤ ${formatSats(worst)} at ${mt} tokens)` +
    (resv !== undefined
      ? ` · needs ${formatSats(resv + deposit)} available (${formatSats(resv)} reserved while it runs${deposit ? ` + ${formatSats(deposit)} deposit for a new connection` : ""})`
      : "") +
    (p.sessionFeeMsat ? ` · session fee ${formatSats(p.sessionFeeMsat)} once per connection` : "") +
    (p.rateSurchargePct ? ` · rates incl. ${p.rateSurchargePct}% surcharge` : "");
  el.classList.remove("too-large");
  const size = attachments.length || turns.some((t) => t.images?.length) ? roughBodyBytes() : 0;
  if (size > BODY_LIMIT) {
    el.textContent = tooLargeText(size);
    el.classList.add("too-large");
  } else if (size > BODY_LIMIT * 0.6) {
    el.textContent += ` · this chat uses ${(size / MIB).toFixed(1)} of the ~${BODY_LIMIT / MIB} MiB a request holds (images are re-sent every message)`;
  }
}

function onModelChange(): void {
  const p = currentModel();
  if (!p) return;
  renderAttach();
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
  const key = credential;
  const nodeApi = api;
  try {
    const b = await nodeApi.balance(key);
    // The key or the node changed meanwhile: this answer is for another one.
    if (key !== credential || nodeApi !== api) return;
    balance = b;
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

/** The signed offer's mints: the node's text, so only strings that are http(s) URLs. */
function offerMints(): string[] {
  const list: unknown = offer?.mints;
  if (!Array.isArray(list)) return [];
  return list.filter((m): m is string => {
    if (typeof m !== "string") return false;
    try {
      return /^https?:$/.test(new URL(m).protocol);
    } catch {
      return false;
    }
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** What to tell the user about a new funded key: copy it, and whether it is stored. */
function fundedKeyNotice(what: string): string {
  return remember
    ? `${what} The key is remembered on this device; copy it too, so the balance is not lost if site data is cleared.`
    : `${what} Copy your key (Wallet → Your key): it is kept only in this tab unless you tick "Remember on this device".`;
}

/** Use `key` for the current node (kept per node; stored only when "remember" is on). */
function setCredential(key: string | undefined): void {
  credential = key;
  balance = undefined;
  if (key) nodeKeys[activeNode] = key;
  else delete nodeKeys[activeNode];
  persistKeys();
  client?.setCredential(key);
  void refreshBalance().then(() => {
    const p = currentModel();
    if (p) client?.prepare(p.id, maxTokens());
  });
}

/** Adopt `key` as the key for `node` (the current node or another one). */
function adoptKey(node: string, key: string): void {
  if (node === activeNode) setCredential(key);
  else {
    nodeKeys[node] = key;
    persistKeys();
  }
}

async function copy(text: string, msg: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    toast("Copy failed; select the text manually");
  }
}

/**
 * Wallet operations in flight (Cashu redeem, invoice creation, withdraw):
 * an automatic update reload waits for them, since their answer (a new key,
 * a withdrawn token) would otherwise be lost.
 */
let walletOps = 0;
async function walletOp<T>(f: () => Promise<T>): Promise<T> {
  walletOps++;
  try {
    return await f();
  } finally {
    walletOps--;
    idle();
  }
}

// Lightning invoices: each one is polled on its own, bound to the node it was
// created at, and kept in sessionStorage so that a reload of this tab still
// collects a payment. A paid invoice whose key differs from the key in use is
// shown with a choice; it never replaces the current key silently.

interface PendingInvoice {
  id: string;
  node: string;
  bolt11: string;
  amountSats: number;
  /** Unix seconds. */
  expiresAt: number;
  created: number;
  /** Created as a top-up of the key then in use (otherwise it creates a new key). */
  topup: boolean;
}
const MAX_INVOICES = 5;
const INVOICE_POLL_MS = 3000;
let invoices: PendingInvoice[] = sload<unknown[]>(SK.invoices, []).filter(
  (i): i is PendingInvoice =>
    !!i && typeof i === "object" && typeof (i as PendingInvoice).id === "string" && typeof (i as PendingInvoice).node === "string" &&
    typeof (i as PendingInvoice).bolt11 === "string" && typeof (i as PendingInvoice).amountSats === "number" &&
    typeof (i as PendingInvoice).expiresAt === "number" && typeof (i as PendingInvoice).created === "number",
);
const invoicePolls = new Map<string, ReturnType<typeof setInterval>>();

function saveInvoices(): void {
  ssave(SK.invoices, invoices.length ? invoices : undefined);
}

function invoiceBoxes(): HTMLElement[] {
  return invoices.map((inv) => {
    // The invoice is the node's text: one a QR code cannot hold must not stop
    // the panel from rendering (it is still there to copy).
    let qrSrc: string | undefined;
    try {
      const qr = qrcode(0, "L");
      qr.addData(inv.bolt11.toUpperCase(), "Alphanumeric");
      qr.make();
      qrSrc = qr.createDataURL(6, 2);
    } catch {
      qrSrc = undefined;
    }
    return h(
      "div",
      { class: "invoice" },
      qrSrc
        ? h("div", { class: "qr" }, h("img", { src: qrSrc, alt: "Lightning invoice QR code" }))
        : h("p", { class: "warnbox" }, "This invoice cannot be shown as a QR code."),
      h("div", { class: "row" }, h("a", { href: `lightning:${inv.bolt11}` }, "Open in wallet"), h("button", { type: "button", onclick: () => copy(inv.bolt11, "Invoice copied") }, "Copy invoice")),
      h(
        "p",
        { class: "muted" },
        `${inv.amountSats} sat${inv.topup ? " top-up" : ", new key"}${inv.node !== activeNode ? ` at ${hostOf(inv.node)}` : ""} · waiting for payment…`,
      ),
    );
  });
}

function renderInvoices(): void {
  document.getElementById("invoice")?.replaceChildren(...invoiceBoxes());
}

function endInvoice(id: string): void {
  const t = invoicePolls.get(id);
  if (t) clearInterval(t);
  invoicePolls.delete(id);
  invoices = invoices.filter((i) => i.id !== id);
  saveInvoices();
  renderInvoices();
}

function watchInvoice(inv: PendingInvoice): void {
  if (invoicePolls.has(inv.id)) return;
  const nodeApi = new NodeApi(inv.node);
  let inFlight = false;
  const poll = async () => {
    if (inFlight || !invoicePolls.has(inv.id)) return;
    if (Date.now() > inv.expiresAt * 1000 || Date.now() - inv.created > 3_600_000) {
      endInvoice(inv.id);
      toast(`The Lightning invoice for ${inv.amountSats} sat expired`);
      return;
    }
    inFlight = true;
    try {
      const st = await nodeApi.lightningStatus(inv.id);
      if (!invoicePolls.has(inv.id)) return;
      if (st.status === "paid") {
        endInvoice(inv.id);
        receiveKey(inv.node, st.api_key ?? undefined, st.amount_sats ?? inv.amountSats);
      } else if (st.status === "expired") {
        endInvoice(inv.id);
        toast(`The Lightning invoice for ${inv.amountSats} sat expired`);
      }
    } catch {
      /* keep polling */
    } finally {
      inFlight = false;
    }
  };
  invoicePolls.set(inv.id, setInterval(() => void poll(), INVOICE_POLL_MS));
}

/** A paid invoice's key: the current one is topped up; a different one is offered, never swapped in. */
function receiveKey(node: string, key: string | undefined, amountSats: number): void {
  const current = nodeKeys[node];
  if (!key || key === current) {
    toast(`Paid ${amountSats} sat`);
    if (node === activeNode) void refreshBalance();
    return;
  }
  if (!current) {
    adoptKey(node, key);
    toast(fundedKeyNotice(`Paid ${amountSats} sat${node !== activeNode ? ` at ${hostOf(node)}` : ""}.`), 10000);
    if (node !== activeNode) renderSide();
    return;
  }
  keyOffers.push({ node, key, amountSats });
  renderKeyOffers();
  toast(`A paid invoice (${amountSats} sat) gave a different key than the one in use: choose in Wallet`, 10000);
}

function keyOfferBoxes(): HTMLElement[] {
  return keyOffers.map((o) => {
    const drop = () => {
      keyOffers = keyOffers.filter((x) => x !== o);
      renderKeyOffers();
    };
    return h(
      "div",
      { class: "warnbox" },
      h(
        "p",
        {},
        `A paid Lightning invoice (${o.amountSats} sat${o.node !== activeNode ? ` at ${hostOf(o.node)}` : ""}) gave a new key, not the key in use. `,
        "Switching replaces the current key in this tab: copy the current key first if it still holds funds. Dismissing forgets the new key, so copy it first.",
      ),
      h("div", { class: "row" }, h("code", {}, short(o.key, 8))),
      h(
        "div",
        { class: "row" },
        h("button", { type: "button", onclick: () => copy(o.key, "New key copied") }, "Copy new key"),
        h(
          "button",
          {
            type: "button",
            onclick: () => {
              drop();
              adoptKey(o.node, o.key);
              toast(fundedKeyNotice("Switched to the new key."), 10000);
            },
          },
          "Use the new key",
        ),
        h("button", { type: "button", class: "secondary", onclick: drop }, "Keep the current key"),
      ),
    );
  });
}

function renderKeyOffers(): void {
  document.getElementById("key-offers")?.replaceChildren(...keyOfferBoxes());
}

async function onLightning(): Promise<void> {
  const amount = Math.trunc(Number($<HTMLInputElement>("ln-amount").value));
  if (!(amount > 0)) return toast("Enter an amount in sats");
  if (invoices.length >= MAX_INVOICES) return toast(`${MAX_INVOICES} invoices are already waiting for payment`);
  const node = activeNode;
  const nodeApi = api;
  const key = credential?.startsWith("sk-") ? credential : undefined;
  try {
    const inv = await walletOp(() => nodeApi.lightningInvoice(amount, key));
    // Pay only what was asked for: the invoice is the node's, the amount the user's.
    const asked = typeof inv.bolt11 === "string" ? bolt11AmountMsat(inv.bolt11) : null;
    if (asked === null) throw new Error("the node's answer is not a Lightning invoice");
    if (asked !== BigInt(amount) * 1000n) {
      throw new Error(
        asked === undefined
          ? "the node's invoice names no amount"
          : `the node's invoice asks for ${Number(asked) / 1000} sat, not the ${amount} sat you entered`,
      );
    }
    const pending: PendingInvoice = {
      id: inv.invoice_id,
      node,
      bolt11: inv.bolt11,
      amountSats: amount,
      expiresAt: inv.expires_at,
      created: Date.now(),
      topup: key !== undefined,
    };
    invoices.push(pending);
    saveInvoices();
    renderInvoices();
    watchInvoice(pending);
  } catch (e) {
    toast(`Invoice failed: ${e instanceof Error ? e.message : e}`, 8000);
  }
}

async function onCashu(): Promise<void> {
  const token = $<HTMLTextAreaElement>("cashu").value.trim();
  if (!token.startsWith("cashu")) return toast("Paste a Cashu token (cashuA… / cashuB…)");
  const key = credential;
  const nodeApi = api;
  const node = activeNode;
  try {
    await walletOp(async () => {
      if (key?.startsWith("sk-")) {
        await nodeApi.topupCashu(key, token);
        toast("Topped up");
        if (node === activeNode) void refreshBalance();
      } else {
        const r = await nodeApi.createKeyFromCashu(token);
        if (nodeKeys[node] && nodeKeys[node] !== r.api_key) {
          // Another key arrived meanwhile: offer this one, do not swap it in.
          keyOffers.push({ node, key: r.api_key, amountSats: Math.floor((r.balance ?? 0) / 1000) });
          renderKeyOffers();
        } else {
          adoptKey(node, r.api_key);
          toast(fundedKeyNotice("Key created."), 10000);
        }
      }
    });
    const ta = document.getElementById("cashu") as HTMLTextAreaElement | null;
    if (ta) ta.value = "";
  } catch (e) {
    toast(`Cashu failed: ${e instanceof Error ? e.message : e}`, 8000);
  }
}

function onPasteKey(): void {
  const k = $<HTMLInputElement>("paste-key").value.trim();
  if (!k.startsWith("sk-")) return toast("Expected an sk- key");
  setCredential(k);
}

function refundTokenBox(): HTMLElement[] {
  if (!refundToken) return [];
  const token = refundToken;
  return [
    h(
      "div",
      { class: "warnbox" },
      h("p", { class: "check" }, "Withdrawn as a Cashu token. Redeem it in any Cashu wallet; it exists only here until you do:"),
      h("textarea", { rows: 4, readOnly: true, value: token }),
      h(
        "div",
        { class: "row" },
        h("button", { type: "button", onclick: () => copy(token, "Token copied") }, "Copy token"),
        h(
          "button",
          {
            type: "button",
            class: "secondary",
            onclick: () => {
              refundToken = undefined;
              document.getElementById("refund-token")?.replaceChildren();
            },
          },
          "I saved it",
        ),
      ),
    ),
  ];
}

/** Longest wait for the node to release a pre-warmed session's reservation before a withdraw. */
const REFUND_WAIT_MS = 30_000;

async function onRefund(): Promise<void> {
  if (!credential) return;
  if (busy) return toast("Wait for the current request to finish");
  if (walletOps) return toast("Wait for the current wallet operation to finish");
  if (!confirm("Withdraw the whole balance and empty this key?")) return;
  const ln = $<HTMLInputElement>("refund-ln").value.trim() || undefined;
  const key = credential;
  const nodeApi = api;
  const status = (text: string, cls = "muted") => document.getElementById("refund-out")?.replaceChildren(h("p", { class: cls }, text));
  const btn = document.getElementById("refund-btn") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  // The node refuses a refund while a reservation is open: stop pre-warming,
  // close the connections (an armed one holds its deposit) and wait until
  // the node released everything.
  client?.setPrewarm(false);
  client?.pool.close();
  try {
    await walletOp(async () => {
      const until = Date.now() + REFUND_WAIT_MS;
      for (;;) {
        const b = await nodeApi.balance(key);
        if (b.reserved === 0) break;
        if (Date.now() > until) {
          throw new Error(`the node still holds ${formatSats(b.reserved)} for an open connection (another tab or device?). Try again in a minute`);
        }
        status(`Waiting for the node to release ${formatSats(b.reserved)} held by an open connection…`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      status("Withdrawing…");
      const r = await nodeApi.refund(key, ln);
      if (typeof r.token === "string") {
        refundToken = r.token;
        document.getElementById("refund-token")?.replaceChildren(...refundTokenBox());
        status("Withdrawn: the token is at the top of the wallet.", "check");
      } else {
        document.getElementById("refund-out")?.replaceChildren(h("p", { class: "check" }, "Withdrawal sent."), h("pre", {}, JSON.stringify(r, null, 2)));
      }
    });
    if (key === credential) void refreshBalance();
  } catch (e) {
    status(`Refund failed: ${e instanceof Error ? e.message : e}`, "cross");
    toast(`Refund failed: ${e instanceof Error ? e.message : e}`, 8000);
  } finally {
    if (btn) btn.disabled = false;
    client?.setPrewarm(prewarmOn);
  }
}

// ─── chat ───────────────────────────────────────────────────────────────────

/** The messages sent for these turns. An empty answer (cut off while reasoning) is not sent back. */
function chatHistory(list: Pick<Turn, "role" | "content" | "images" | "error">[]): { role: string; content: unknown }[] {
  return list
    .filter((t) => !t.error && (t.content || t.images?.length))
    .map((t) => ({ role: t.role, content: t.images?.length ? imageContent(t.content, t.images) : t.content }));
}

/**
 * Largest request body this app sends: the relay's limit is 8 MiB, and the
 * pinned suffix and the padding to a length bucket need some room.
 */
const BODY_LIMIT = 7.5 * 1024 * 1024;
const MIB = 1024 * 1024;

function bodyBytes(body: unknown): number {
  return new TextEncoder().encode(JSON.stringify(body)).length;
}

/** A quick estimate of the next request body (for the hint under the model; the send check is exact). */
function roughBodyBytes(): number {
  const prompt = (document.getElementById("prompt") as HTMLTextAreaElement | null)?.value ?? "";
  let n = 512 + prompt.length * 1.1;
  for (const t of turns) n += 64 + t.content.length * 1.1 + (t.images ?? []).reduce((a, u) => a + u.length + 64, 0);
  for (const u of attachments) n += u.length + 64;
  return n;
}

function tooLargeText(bytes: number): string {
  return `This chat is too large to send (${(bytes / MIB).toFixed(1)} MiB; a request holds about ${BODY_LIMIT / MIB} MiB). Images from earlier messages are sent again with every message: remove an attached image, or start a new chat ("New chat").`;
}

/** `reasoning_effort` when one is chosen (sent inside the encrypted body; the node never sees it). */
function reasoningParam(): { reasoning_effort?: string } {
  const v = ($<HTMLSelectElement>("reasoning")?.value ?? "default");
  return v === "default" ? {} : { reasoning_effort: v };
}

function clearChat(): void {
  if (busy) return toast("Wait for the current answer to finish");
  turns.length = 0;
  attachments = [];
  renderAttachments();
  selected = undefined;
  $("messages").replaceChildren(emptyState());
  renderSide();
  renderEstimate();
}

function addTurn(role: Turn["role"], content: string, images?: string[]): Turn {
  document.getElementById("empty")?.remove();
  const el = h("div", { class: `msg ${role}` }, role === "assistant" ? "" : content);
  if (images?.length) el.prepend(h("div", { class: "msg-images" }, ...images.map((src) => h("img", { src, alt: "attached image" }))));
  if (role === "assistant" && content) {
    const body = h("div", { class: "md" }, "");
    body.innerHTML = renderMarkdown(content);
    el.append(body);
  }
  const t: Turn = { role, content, el, images };
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
  if (!text && !attachments.length) return;
  const p = currentModel();
  if (!p) return toast("No confidential model available");
  if (!credential) return toast("Fund the wallet first (Lightning or Cashu)");
  const withImages = attachments.length > 0 || turns.some((t) => t.images?.length);
  if (withImages && !acceptsImages(p.id)) return toast(`${p.name ?? p.id} does not accept images: pick a vision model, or start a new chat`);
  // The relay takes at most 8 MiB per request, and every earlier image is sent
  // again: refuse here, with what to do, rather than fail at the relay.
  const size = bodyBytes({
    messages: chatHistory([...turns, { role: "user", content: text, images: attachments.length ? attachments : undefined }]),
    model: p.id,
    max_tokens: maxTokens(),
    ...reasoningParam(),
    stream: true,
  });
  if (size > BODY_LIMIT) {
    renderEstimate();
    return toast(tooLargeText(size), 15000);
  }
  ta.value = "";
  addTurn("user", text, attachments.length ? attachments : undefined);
  attachments = [];
  renderAttachments();
  // An empty answer (cut off while reasoning) is not sent back as history.
  const history = chatHistory(turns);
  const answer = addTurn("assistant", "");
  const body = h("div", { class: "md" }, "");
  const view = streamingMarkdown(body);
  // Reasoning models stream their thinking separately (reasoning_content):
  // collapsed; click to expand (it keeps streaming inside).
  const thinkingText = h("div", { class: "thinking-text" }, "");
  const thinking = h("details", { class: "thinking", hidden: true }, h("summary", {}, "thinking…"), thinkingText);
  let reasoning = "";
  let finish: string | null | undefined;
  const meta = h("div", { class: "meta" });
  answer.el.replaceChildren(thinking, body, meta);
  answer.meta = meta;
  const chatProgress = progressLine("chat", meta, "Starting a confidential request…");
  activeProgress = chatProgress;
  busy = true;
  $<HTMLButtonElement>("send").disabled = true;
  const t0 = performance.now();
  let stream: ConfidentialStream | undefined;
  try {
    stream = await client.chat.completions.create({
      model: p.id,
      messages: history,
      max_tokens: maxTokens(),
      ...reasoningParam(),
      stream: true,
    });
    if (activeProgress === chatProgress) activeProgress = undefined;
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
      framing: r.framing,
      n: r.n,
      sid: r.sid.slice(0, 8),
      connection: r.connection,
      fellBack: r.fellBack,
      bytes: { sent: r.bytes.sent, recv: r.bytes.recv },
      setupBytes: r.setupBytes,
      deposit: r.deposit,
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
    if (r.http.status >= 400) {
      // The provider refused: the node disclosed only the error head and
      // settled it. The receipt verified, so the charge is known and fair;
      // there is no answer to show, only what happened.
      body.replaceChildren(providerErrorNotice(r));
      answer.el.classList.add("provider-error");
    }
    meta.replaceChildren(
      h("span", { class: "check" }, r.http.status >= 400 ? "receipt verified" : "verified"),
      h(
        "span",
        { class: "framing", title: `connection ${r.sid.slice(0, 8)}, request ${r.n} on it${r.stream !== undefined ? `, HTTP/2 stream ${r.stream}` : ""}` },
        `${FRAMING_LABEL[r.framing]}${r.framing === "2" ? ` · #${r.n}` : ""}${r.fellBack ? " (fallback)" : ""}`,
      ),
      h("span", {}, connectionLabel(r)),
      h("span", {}, `first token ${(r.ttftMs / 1000).toFixed(1)} s`),
      h("span", {}, `total ${((performance.now() - t0) / 1000).toFixed(1)} s`),
      h("span", {}, usage ? `${usage.prompt_tokens}/${usage.completion_tokens} tok` : ""),
      h("span", {}, formatSats(r.costMsats ?? 0)),
      h("button", { type: "button", onclick: () => showDetails(answer) }, "details"),
    );
    selectTurn(answer);
  } catch (err) {
    // Stopped after the request reached the provider: the session still
    // settles, and its receipt says what was charged.
    if (stream && err instanceof Error && err.name === "AbortError") {
      const r = await stream.verification.catch(() => undefined);
      if (r) {
        answer.result = r;
        answer.error = "stopped";
        meta.replaceChildren(
          h("span", { class: "cross" }, "stopped"),
          h("span", {}, `charged ${formatSats(r.costMsats ?? 0)} (receipt ${r.receiptSigOk ? "verified" : "not verified"})`),
          h("button", { type: "button", onclick: () => showDetails(answer) }, "details"),
        );
        selectTurn(answer);
        return;
      }
    }
    const msg = friendlyError(err);
    answer.error = msg;
    answer.errorDetail = errorDetail(err);
    testHook().errors.push(msg);
    answer.el.classList.add("error");
    if (!answer.content) body.textContent = "";
    meta.replaceChildren(h("span", { class: "cross" }, msg), h("button", { type: "button", onclick: () => showDetails(answer) }, "details"));
    selectTurn(answer);
  } finally {
    if (activeProgress === chatProgress) activeProgress = undefined;
    busy = false;
    $<HTMLButtonElement>("send").disabled = false;
    void refreshBalance();
    idle();
  }
}

// ─── image input (chat) ─────────────────────────────────────────────────────
//
// An attached image travels in the private request body as a data URI image
// part: the node relays it encrypted and never sees it, and the provider bills
// it as prompt tokens, which the usage proof discloses and the node charges at
// the signed input rate (the reservation already covers a full-context prompt).
// A remote image URL would make the provider fetch it, telling the image host
// about the request, so only local files are attached.

/** Longest side sent; vision models downscale larger images anyway. */
const IMAGE_MAX_SIDE = 1568;
/** Providers refuse smaller images (Venice: at least 64x64). */
const IMAGE_MIN_SIDE = 64;
const IMAGE_MAX_COUNT = 4;
/** A rough per-image prompt-token count for the estimate (a 1024 px image is a few hundred to ~1,500). */
const IMAGE_TOKENS_GUESS = 800;

function imageInputModels(models: { id: string; [k: string]: unknown }[]): Set<string> | undefined {
  const out = new Set<string>();
  let known = false;
  for (const m of models) {
    const mods = (m.architecture as { input_modalities?: unknown } | undefined)?.input_modalities;
    if (!Array.isArray(mods)) continue;
    known = true;
    if (mods.includes("image")) out.add(m.id);
  }
  return known ? out : undefined;
}

function acceptsImages(model: string): boolean {
  return !visionModels || visionModels.has(model);
}

function imageContent(text: string, images: string[]): unknown[] {
  return [...(text ? [{ type: "text", text }] : []), ...images.map((url) => ({ type: "image_url", image_url: { url } }))];
}

/** Decode, downscale and re-encode as JPEG (accepted by every vision model), as a data URI. */
async function prepareImage(file: File): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name || "the image"} could not be decoded`);
  }
  try {
    if (Math.min(bitmap.width, bitmap.height) < IMAGE_MIN_SIDE) {
      throw new Error(`${file.name || "the image"} is ${bitmap.width}x${bitmap.height}; images must be at least ${IMAGE_MIN_SIDE}x${IMAGE_MIN_SIDE}`);
    }
    const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(IMAGE_MIN_SIDE, Math.round(bitmap.width * scale));
    canvas.height = Math.max(IMAGE_MIN_SIDE, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("this browser cannot re-encode images");
    ctx.fillStyle = "#fff"; // transparent PNGs: JPEG has no alpha
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    bitmap.close();
  }
}

async function addAttachments(files: File[]): Promise<void> {
  const p = currentModel();
  if (p && !acceptsImages(p.id)) return toast(`${p.name ?? p.id} does not accept images: pick a vision model`);
  for (const f of files) {
    if (attachments.length >= IMAGE_MAX_COUNT) {
      toast(`At most ${IMAGE_MAX_COUNT} images per message`);
      break;
    }
    try {
      attachments.push(await prepareImage(f));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  }
  renderAttachments();
  client?.activity();
}

function renderAttachments(): void {
  const strip = document.getElementById("attachments");
  if (!strip) return;
  strip.hidden = mode === "image" || !attachments.length;
  strip.replaceChildren(
    ...attachments.map((src, i) =>
      h(
        "div",
        { class: "attachment" },
        h("img", { src, alt: `attachment ${i + 1}` }),
        h("button", { type: "button", title: "Remove", "aria-label": "Remove image", onclick: () => { attachments.splice(i, 1); renderAttachments(); } }, "×"),
      ),
    ),
    h("span", { class: "muted" }, `Encrypted to the provider, billed as input tokens, and re-sent with every later message in this chat. A request holds about ${BODY_LIMIT / MIB} MiB; when a chat with images reaches that, start a new chat.`),
  );
  renderEstimate();
}

/** The attach button: off for models the node lists as text-only. */
function renderAttach(): void {
  const b = document.getElementById("attach") as HTMLButtonElement | null;
  const p = currentModel();
  if (!b || !p) return;
  const ok = acceptsImages(p.id);
  b.disabled = !ok;
  b.title = ok ? "Attach an image" : `${p.name ?? p.id} does not accept image input`;
}

/** The provider's own error message from an error body (JSON `error.message`, `error`, `message` or `detail`), if any. */
function providerMessage(text: string): string | undefined {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const e = j.error;
    const m =
      (e && typeof e === "object" ? (e as Record<string, unknown>).message : e) ?? j.message ?? j.detail;
    if (typeof m === "string" && m.trim()) return m.trim().slice(0, 300);
  } catch {
    /* not JSON */
  }
  const t = text.trim();
  return t && t.length <= 300 && !/[<{]/.test(t[0]!) ? t : undefined;
}

/** A chat answer the provider refused (status >= 400): what happened, what it cost, what to do. */
function providerErrorNotice(r: ConfidentialSessionResult): HTMLElement {
  const st = r.http.status;
  const said = providerMessage(r.responseText ?? "");
  const cost = r.costMsats ?? 0;
  const todo =
    st === 401 || st === 402 || st === 403
      ? "The provider account behind this node has a problem (for example its balance). Try again later, or use another node."
      : st === 429
        ? "The provider is rate-limiting this node. Wait a minute and send again."
        : st >= 500
          ? "The provider had a temporary problem. Send the message again."
          : "The provider could not handle this request. Change the message or the model and try again.";
  return h(
    "div",
    { class: "notice provider-error-notice" },
    h("p", {}, `The provider refused this message (HTTP ${st}${said ? `: ${said}` : ""}). There is no answer.`),
    h("p", {}, cost > 0 ? `It cost ${formatSats(cost)} (the signed receipt checks out; usually the session fee).` : "It cost nothing (the signed receipt checks out)."),
    h("p", {}, todo),
    h(
      "details",
      { class: "error-detail" },
      h("summary", {}, "details"),
      h("pre", {}, `HTTP ${st} ${r.http.statusText ?? ""}\n${(r.responseText ?? "").slice(0, 4000)}`),
    ),
  );
}

/** The technical text of an error, kept under "details" next to the plain one. */
function errorDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { code?: unknown }).code;
  const detail = (err as { detail?: unknown }).detail;
  return [typeof code === "string" ? `[${code}]` : "", err.message, typeof detail === "string" && detail ? `(${detail})` : ""].filter(Boolean).join(" ");
}

/** Whether money was taken, from the library's release marker. */
function moneyNote(err: unknown): string {
  return mayHaveReachedProvider(err)
    ? "Your message may have reached the provider, so it may be charged (your balance will show it). It is not sent again automatically."
    : "Your message did not reach the provider and was not charged.";
}

/**
 * One sentence a non-expert can act on for every error the library throws:
 * what happened, whether money was taken, what to do. The raw text stays
 * available through errorDetail.
 */
function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const rawCode = err instanceof Error ? (err as { code?: unknown }).code : undefined;
  const code = typeof rawCode === "string" ? rawCode : undefined;
  const status = (err as { status?: unknown } | undefined)?.status;
  // Specific classes first (several share a code).
  if (err instanceof NodeProtocolOutdatedError) {
    return `This node runs an old protocol (routstr-confidential v${err.nodeVersion}); this app speaks v3. The node must be updated before it can serve confidential requests. Nothing was charged.`;
  }
  if (err instanceof UpgradeRequiredError) return "The node speaks a newer protocol than this app. Reload the page to update the app. Nothing was charged.";
  if (err instanceof TwoPcVersionMismatchError) return "This app and the node run different versions of the secure setup. Reload the page to update, or pick another node. The node may keep the connection deposit: the mismatch shows only after the deposit was reserved.";
  if (err instanceof ConnectionDepositError) {
    return err.status === 402
      ? `Not enough balance for the connection deposit of ${formatSats(err.depositMsat)}. Top up the wallet and try again. Nothing was charged.`
      : `The node asks for a connection deposit of ${formatSats(err.depositMsat)}, more than this app accepts. Nothing was sent or charged. Use another node.`;
  }
  if (err instanceof StreamNotProcessedError) {
    return `The provider was busy and turned your message away without reading it, again after an automatic retry. ${err.receipt ? `The node charged ${formatSats(err.costMsats ?? 0)} for it (the session fee, if it was due).` : "It was not charged."} Wait a moment and send it again.`;
  }
  if (err instanceof PoolBusyError) return "Other messages are still using every connection to this node. Wait for them to finish and send again. Nothing was charged.";
  if (err instanceof ReservationAboveCeilingError) {
    return `The node wanted to hold ${formatSats(err.reservedMsat)} while this message runs, more than this app allows (${formatSats(err.ceilingMsat)}). Nothing was sent or charged. Lower max tokens, pick another model, or use another node.`;
  }
  if (err instanceof RequestRefusedError) {
    if (err.status === 402) return "Not enough balance for this message. Top up, or lower max tokens. Nothing was charged; the connection stays open for the next try.";
    if (err.status === 401 || err.status === 403) return "The node does not accept your key for this message. Nothing was charged. Check the key in the Wallet panel.";
    if (err.status === 429) return "The node is busy. Nothing was charged. Wait a minute and send again.";
    if (/offer_(expired|changed)/.test(err.reason)) return "The node changed its prices. Nothing was charged. Reload the page to accept the new ones, then send again.";
    return "The node turned this message down. Nothing was charged; the connection stays open. Send it again, or use another node if this repeats.";
  }
  switch (code) {
    case "offer_unavailable":
      return "Cannot reach the node. Check your internet connection and the node URL in the Node panel, then try again. Nothing was charged.";
    case "offer_malformed":
      return "The node's price list is not in a form this app can read, so the app does not use the node. Nothing was charged. Reload to update the app, or use another node.";
    case "offer_bad_signature":
      return "The node's price list is not signed correctly, so the app does not trust it. Nothing was charged. Use another node.";
    case "offer_unpinned":
      return "No node key is set, so the app cannot check who it is talking to. Enter the node key in the Node panel. Nothing was charged.";
    case "offer_pin_mismatch":
      return "The node signed with a different key than the one in the Node panel. Nothing was sent or charged. Check the node key, or use another node.";
    case "offer_unsupported_version":
      return "The node uses a protocol version this app does not support. Reload to update the app, or use another node. Nothing was charged.";
    case "trusted_host_rejected":
      return "The node forwards to a provider you have not marked as trusted. Nothing was sent or charged. Change \"Trusted provider host\" in the Node panel only if you trust that provider.";
    case "session_protocol":
      return `The node did not follow the protocol, so the app stopped. ${moneyNote(err)} Try again; if it repeats, use another node.`;
    case "session_rejected":
      if (status === 402) return "Not enough balance for this message. Top up, or lower max tokens. Nothing was charged.";
      if (status === 429) return "The node already holds too many connections for your address (other tabs or devices on the same network). Close them or wait a few minutes. Nothing was charged.";
      if (status === 409) return "The node changed its prices or fees. Reload the page to accept the new ones. Nothing was charged.";
      if (status === 401 || status === 403) return "The node does not accept your key. Nothing was charged. Check the key in the Wallet panel.";
      return `The node closed the connection. ${moneyNote(err)} Try again; if it repeats, use another node.`;
    case "prover_failed":
      return `A proof could not be made or did not check out, so the app stopped. ${moneyNote(err)} Try again; if it repeats, use another node.`;
    case "prover_missing":
      return "The proof engine did not load in this browser. Reload the page. Nothing was charged.";
    case "receipt_verification":
      return "The node's receipt does not check out. Do not trust this answer or its charge. Check your balance, and consider using another node.";
    case "response_verification":
      return "The answer could not be verified. Do not trust it. Try again; if it repeats, use another node.";
    case "timeout":
      return `The request took too long and was stopped. ${moneyNote(err)} Check your internet connection and try again.`;
    case "not_configured":
      return "The app is not set up for this node. Check the Node panel (URL, node key, trusted provider host).";
    case "unsupported_endpoint":
      return "This node cannot serve this kind of request. Nothing was charged.";
    case "offer_no_images":
      return "This node does not offer image generation. Nothing was charged.";
    case "pinned_parameter":
      return "A setting of this request is fixed by the node and cannot be changed here. Nothing was sent or charged. Change the setting and try again.";
    case "upstream_error":
      return `The provider returned an error${typeof status === "number" ? ` (HTTP ${status})` : ""}. The receipt shows what it cost. Try again later, or pick another model.`;
    case "request_refused":
      return "The node turned this message down. Nothing was charged. Send it again, or use another node if this repeats.";
    case "reservation_above_ceiling":
      return "The node wanted to hold more for this message than this app allows. Nothing was sent or charged. Lower max tokens or use another node.";
    case "node_protocol_outdated":
      return "This node runs an old protocol and must be updated before it can serve confidential requests. Nothing was charged.";
    case "upgrade_required":
      return "The node speaks a newer protocol than this app. Reload the page to update the app. Nothing was charged.";
    case "twopc_version_mismatch":
      return "This app and the node run different versions of the secure setup. Reload the page to update, or pick another node. The node may keep the connection deposit: the mismatch shows only after the deposit was reserved.";
  }
  if (code) return `Something went wrong (${code}). ${moneyNote(err)} Try again; the details below say more.`;
  return raw;
}

/**
 * Outcomes for the browser tests: in every build only non-secret results and
 * errors (no credential, no prompt). The helpers that reach the client (and
 * with it the credential), the conversation and the event log are in a build
 * made for the tests only (`VITE_TEST_HOOKS=1 npm run build`), never in the
 * deployed app.
 */
function testHook(): { results: unknown[]; errors: string[]; renderMarkdown?: (t: string) => string } {
  const w = window as unknown as { __rc?: { results: unknown[]; errors: string[]; renderMarkdown?: (t: string) => string } };
  if (w.__rc) return w.__rc;
  if (import.meta.env.VITE_TEST_HOOKS !== "1") {
    w.__rc = { results: [], errors: [] };
    return w.__rc;
  }
  w.__rc = {
    results: [],
    errors: [],
    renderMarkdown,
    waterfall,
    reencode,
    client: () => client,
    addTurn: (role: Turn["role"], content: string) => void addTurn(role, content),
    turns: () => turns.map((t) => ({ role: t.role, content: t.content })),
    event: (e: Record<string, unknown>) => logEvent({ t: Date.now(), ...e }),
    friendlyError: (code: string, message = "test", props: Record<string, unknown> = {}) =>
      friendlyError(Object.assign(new Error(message), { code }, props)),
    errorCodes: [...CONFIDENTIAL_ERROR_CODES],
  } as never;
  return w.__rc;
}

// ─── image mode ─────────────────────────────────────────────────────────────
// Confidential image generation: one cold session per request (never
// pre-armed), flat-priced at the signed offer's per-image price. The prompt
// and the aspect ratio stay private; the node sees the model, the resolution
// tier and the count it charges for.

const ASPECTS = ["16:9", "4:3", "1:1"];
const PREFERRED_IMAGE_MODEL = "qwen-image-2-1-turbo";
/** Protocol data of a new connection (2PC ~16.4 MB down, ~1.1 MB up, proof channel, handshake), before the image itself. */
const SETUP_MB_PER_IMAGE = 21;
let galleryLoaded = false;
let imageBodySent = false;

/** The parsed image block of the current offer (a malformed block means: no images; chat is unaffected). */
let imagesParsed: { offer: VerifiedOffer; images?: ConfidentialImagesOffer; error?: string } | undefined;

function imagesOffer(): ConfidentialImagesOffer | undefined {
  if (!offer) return undefined;
  if (imagesParsed?.offer !== offer) {
    try {
      imagesParsed = { offer, images: offerImages(offer) };
    } catch (e) {
      imagesParsed = { offer, error: e instanceof Error ? e.message : String(e) };
      logEvent({ ev: "images_offer_refused", msg: imagesParsed.error });
    }
  }
  return imagesParsed.images;
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
    el.textContent = !offer
      ? ""
      : imagesParsed?.error
        ? "This node's image offer is malformed, so image generation is off (chat works)."
        : "This node does not offer confidential image generation.";
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
    ` · about ${SETUP_MB_PER_IMAGE} MB of setup data on a new connection (on HTTP/2 an image reuses the chat's open connection)` +
    (abandon ? ` · cancelled before sending: the deposit or ${formatSats(abandon)}` : "");
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
  $("attach").hidden = image;
  $("attachments").hidden = image || !attachments.length;
  if (image && !galleryLoaded) void loadGallery();
  if (image) renderImageEstimate();
}

async function loadGallery(): Promise<void> {
  galleryLoaded = true;
  const g = $("gallery");
  const stored = await listImages();
  if (!stored.length) {
    g.replaceChildren(h("div", { class: "empty", id: "gallery-empty" }, h("p", {}, "Images you generate appear here. They are kept only in this browser."), h("p", { class: "muted" }, "Each image is a confidential request (on HTTP/2 it reuses the chat's open connection): the provider receives your prompt encrypted end to end, and the node charges the signed flat price.")));
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
    `A confidential image request on a new connection moves about ${SETUP_MB_PER_IMAGE} MB of setup data (the two-party handshake and the proofs) before the image itself. Continue on this network?`,
  );
}

/** What each step of an image request means, in plain words. */
const IMAGE_STAGES: Record<string, string> = {
  request: "starting the confidential request…",
  ready: "secure setup: the node checked the key and reserved the connection deposit…",
  armed: "secure setup done (2PC preparation and key share); TLS handshake with the provider…",
  certificate_verified: "provider certificate verified; proving the node's key record…",
  open: "connection open; sending the encrypted prompt…",
  request_sent: "request sent; proving its records (π_WIN)…",
  body_sent: "request sent; proving the pinned price parameters (π_WIN)…",
  pi_win_ok: "pinned price parameters proven; waiting for the image…",
  attestation: "verifying the response and the node's attestation…",
};

/** What each step of a chat request means, until the answer starts. */
const CHAT_STAGES: Record<string, string> = {
  ready: "The node accepted your key. Setting up a secure connection (a one-time download)…",
  armed: "Secure setup done. Connecting to the provider…",
  certificate_verified: "The provider's certificate checks out. Checking that the node adds only its key…",
  open: "Connected. Sending your encrypted message…",
  request_sent: "Message sent. Proving it carries the model and limits you chose…",
  body_sent: "Message sent. Proving it carries the model and limits you chose…",
  pi_win_ok: "Proof checked. Waiting for the first words of the answer…",
  request_retry: "The connection dropped before your message left. Trying again on a new one…",
  refusal_settled: "The provider was busy and turned the message away unread. Trying again…",
};

/** A progress line: the stage text and a bar (shown only while the 2PC data downloads). */
function progressLine(kind: "chat" | "images", el: HTMLElement, text: string): Progress {
  const t = h("span", { class: "stage" }, text);
  const bar = h("progress", { class: "twopc-bar", max: 1, value: 0, hidden: true });
  el.replaceChildren(t, bar);
  return { kind, text: t, bar };
}

function progressEvent(p: Progress, e: Record<string, unknown>): void {
  if (e.ev === "twopc_progress") {
    const received = Number(e.received);
    const expected = Number(e.expected);
    if (!(received >= 0) || !(expected > 0)) return;
    p.bar.hidden = false;
    p.bar.max = expected;
    p.bar.value = Math.min(received, expected);
    p.text.textContent = `Setting up a secure connection: ${(Math.min(received, expected) / 1e6).toFixed(1)} of ${(expected / 1e6).toFixed(1)} MB…`;
    return;
  }
  if (e.ev === "response_progress" && typeof e.bytes === "number" && p.kind === "images") {
    p.bar.hidden = true;
    p.text.textContent = `downloading the image (${(e.bytes / 1e6).toFixed(1)} MB)…`;
    return;
  }
  let text: string | undefined;
  if (p.kind === "images") text = IMAGE_STAGES[String(e.ev)];
  else if (e.ev === "request") {
    text = e.path === "reused" ? "Using the open connection…" : e.path === "armed" ? "Using a prepared connection…" : "Opening a new confidential connection…";
  } else text = CHAT_STAGES[String(e.ev)];
  if (!text) return;
  // The bar belongs to the setup download: any later step hides it.
  if (e.ev !== "ready") p.bar.hidden = true;
  p.text.textContent = text;
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
  activeProgress = progressLine("images", progress, "starting a confidential session…");
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
    activeProgress = undefined;
    const tiles: HTMLElement[] = [];
    const warnings = [...out.warnings];
    for (const blob of out.images) {
      const small = await reencode(blob);
      if (!small) {
        warnings.push("an image could not be decoded in this browser and was not kept");
        continue;
      }
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
    // The request was paid: anything short or broken is said, not hidden.
    const note = warnings.length
      ? h("div", { class: "msg assistant error" }, h("div", {}, prompt), h("div", { class: "notice" }, `Charged, but: ${warnings.join("; ")}.`))
      : null;
    card.replaceWith(...(note ? [note] : []), ...tiles);
    if (tiles[0]) showImageDetails(tiles[0], out.confidential);
  } catch (err) {
    activeProgress = undefined;
    if (ctrl.signal.aborted) {
      cancel.remove();
    } else {
      const msg =
        err instanceof UpstreamImageError
          ? `The provider turned the image request down (HTTP ${err.status}). The receipt checks out: a turned-down request costs at most a small fee. Change the prompt or the model, or try again later.`
          : friendlyError(err);
      testHook().errors.push(msg);
      card.classList.add("error");
      const details =
        err instanceof UpstreamImageError
          ? h("button", { type: "button", onclick: () => showImageDetails(card, err.result as ConfidentialSessionResult) }, "details")
          : null;
      progress.replaceChildren(errorBox(msg, errorDetail(err)));
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
  // A key belongs to the node that issued it: a new node URL gets its own
  // key (or none), never the previous node's.
  if (settings.node !== activeNode) {
    const had = credential !== undefined;
    activeNode = settings.node;
    credential = nodeKeys[activeNode];
    balance = undefined;
    if (had) {
      toast(
        credential
          ? `Using the key kept for ${hostOf(activeNode)}.`
          : `No key for ${hostOf(activeNode)} yet: your other key stays with its node and is not sent here.`,
        8000,
      );
    }
  }
  offer = undefined;
  offerError = undefined;
  offerErrorDetail = undefined;
  outdatedNode = undefined;
  nextFraming = undefined;
  pricing = [];
  makeClient();
  renderStatus();
  renderSide();
  try {
    offer = await client!.offer();
    pricing = await client!.pricing(maxTokens());
    void client!.models().then((list) => {
      visionModels = imageInputModels(list);
      renderAttach();
    }, () => undefined);
    renderModels();
    renderImageControls();
    void mintInputFees(offerMints()).then((f) => {
      mintFees = f;
      renderSide();
    });
  } catch (e) {
    offerError = friendlyError(e);
    offerErrorDetail = errorDetail(e);
    if (e instanceof NodeProtocolOutdatedError) outdatedNode = e.nodeVersion;
  }
  void updateFraming();
  renderStatus();
  renderSide();
  await refreshBalance();
  const p = currentModel();
  if (p) client?.prepare(p.id, maxTokens());
}

window.addEventListener("beforeunload", (e) => {
  // An automatic update reload has stashed everything below for this tab.
  if (autoReloading) return;
  const fundedKeyOnlyHere = credential && !remember && balance && balance.balance > 0;
  if (fundedKeyOnlyHere || refundToken || keyOffers.length || invoices.length) e.preventDefault();
});

testHook();
layout();
restoreTurns();
renderSide();
for (const inv of invoices) watchInvoice(inv);
setupPwa({ isBusy: () => busy || walletOps > 0, toast, beforeReload: stashForReload });
void restart();
setInterval(() => void refreshBalance(), 60_000);

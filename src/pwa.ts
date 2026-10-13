/**
 * Release versioning and automatic update (house rule: never rely on a hard
 * refresh). The running version is compiled in (__APP_VERSION__); the
 * deployed one is read from version.json (no-store) on load, when the tab
 * becomes visible and every 5 minutes. A new version makes the service
 * worker update; the new worker activates at once (skipWaiting +
 * clients.claim) and the page reloads on `controllerchange` — deferred while
 * a confidential request is in flight — and then shows "Updated to vX".
 * Without a worker change (no service worker, a blocked or failed install) it
 * reloads once per new version.
 */

declare const __APP_VERSION__: string;
declare const __APP_BUILD__: string;

export const APP_VERSION = __APP_VERSION__;
export const APP_BUILD = __APP_BUILD__;

const CHECK_MS = 5 * 60_000;
const FLAG = "routstr-confidential:updated-from";
const TRIED = "routstr-confidential:fallback-reload";
/** How long a new worker may take to install before a plain reload. */
const INSTALL_WAIT_MS = 120_000;
/** Shortest interval between two plain reloads for the same new version. */
const RETRY_MS = 15 * 60_000;

let busy = () => false;
let pendingReload = false;
let toast: (msg: string) => void = () => {};

function reload(): void {
  if (busy()) {
    pendingReload = true;
    toast("A new version is ready; it loads when the current answer finishes.");
    return;
  }
  try {
    sessionStorage.setItem(FLAG, APP_VERSION);
  } catch {
    /* ignore */
  }
  location.reload();
}

/**
 * Reload without a worker change, at most once per new version every
 * RETRY_MS in this tab: if the reload still shows the old version (the
 * browser may serve the page from its HTTP cache for a few minutes), a later
 * check tries again instead of reloading in a loop.
 */
function fallbackReload(version: string): void {
  try {
    const [v, at] = (sessionStorage.getItem(TRIED) ?? "").split("|");
    if (v === version && Date.now() - Number(at) < RETRY_MS) return;
    sessionStorage.setItem(TRIED, `${version}|${Date.now()}`);
  } catch {
    /* ignore */
  }
  reload();
}

/** Call when a request finished, to apply a deferred update. */
export function idle(): void {
  if (pendingReload && !busy()) reload();
}

async function remoteVersion(): Promise<string | undefined> {
  try {
    const r = await fetch(`./version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return undefined;
    const j = (await r.json()) as { version?: string };
    return typeof j.version === "string" ? j.version : undefined;
  } catch {
    return undefined;
  }
}

export function setupPwa(opts: { isBusy: () => boolean; toast: (msg: string) => void }): void {
  busy = opts.isBusy;
  toast = opts.toast;
  try {
    const from = sessionStorage.getItem(FLAG);
    if (from) {
      sessionStorage.removeItem(FLAG);
      if (from !== APP_VERSION) toast(`Updated to v${APP_VERSION}`);
    }
  } catch {
    /* ignore */
  }
  if (!("serviceWorker" in navigator) || import.meta.env.DEV) return;
  let reg: ServiceWorkerRegistration | undefined;
  const hadController = !!navigator.serviceWorker.controller;
  /** The deployed version a new worker is installing for, once seen. */
  let waitingFor: string | undefined;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // The first install takes control without a new version: no reload. A
    // worker taking over after a version check found a new release does
    // reload, also in a tab that started without a controller.
    if (hadController || waitingFor !== undefined) reload();
  });
  navigator.serviceWorker
    .register("./sw.js", { scope: "./", updateViaCache: "none" })
    .then((r) => {
      reg = r;
      r.addEventListener("updatefound", () => {
        const w = r.installing;
        w?.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller) w.postMessage("skipWaiting");
        });
      });
    })
    .catch(() => {});
  const check = async () => {
    const v = await remoteVersion();
    if (!v || v === APP_VERSION) return;
    if (!reg) return fallbackReload(v);
    await reg.update().catch(() => {});
    const w = reg.installing ?? reg.waiting;
    if (!w) {
      // No new worker (service worker blocked, or sw.js not yet updated):
      // the page itself loads the new version from the network.
      fallbackReload(v);
      return;
    }
    // A new worker is installing (it precaches the release, which takes a
    // while on a slow link): `controllerchange` reloads once it takes over.
    // Reloading before that would land on the old worker, so only a failed
    // install or one that never finishes falls back to a plain reload.
    if (waitingFor === v) return;
    waitingFor = v;
    if (w.state === "installed") w.postMessage("skipWaiting");
    w.addEventListener("statechange", () => {
      if (w.state === "installed") w.postMessage("skipWaiting");
      if (w.state === "redundant") fallbackReload(v);
    });
    setTimeout(() => {
      if (!pendingReload) fallbackReload(v);
    }, INSTALL_WAIT_MS);
  };
  void check();
  setInterval(check, CHECK_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void check();
  });
}

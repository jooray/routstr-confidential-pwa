import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { defineConfig, type Plugin } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
  dependencies: Record<string, string>;
};
/** APP_VERSION overrides the release version (used by scripts/update-test.mjs only). */
const VERSION = process.env.APP_VERSION ?? pkg.version;
const BUILD = new Date().toISOString();
/** The commit this build came from (shown in the footer, linked to GitHub). */
const GIT_SHA =
  process.env.GITHUB_SHA ??
  (() => {
    try {
      return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return "unknown";
    }
  })();
const libPkg = JSON.parse(
  readFileSync(new URL("./node_modules/@routstr/confidential-web/package.json", import.meta.url), "utf8"),
) as { version: string };
/** The library ref pinned in package.json (`github:…#<commit>`), or "local" for a linked checkout. */
const LIB_SPEC = pkg.dependencies["@routstr/confidential-web"] ?? "";
const LIB_REF = LIB_SPEC.includes("#") ? LIB_SPEC.split("#")[1]! : "local";
/** GitHub Pages serves the app under /routstr-confidential-pwa/; BASE overrides (e.g. "/" locally). */
const BASE = process.env.BASE ?? "/routstr-confidential-pwa/";

/**
 * Release versioning for the PWA (house rule: every release is versioned and
 * the app refreshes itself, never relying on a hard refresh):
 *  - `version.json` {version, build, assets_sha256} is fetched (no-store) on load,
 *    on focus and every 5 minutes; a different version triggers an update;
 *  - `sw.js` is regenerated per build with the version in its cache name and
 *    the exact asset list; it installs with skipWaiting + clients.claim and
 *    the page reloads on `controllerchange`.
 */
function pwaRelease(): Plugin {
  let outDir = "dist";
  return {
    name: "pwa-release",
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      const files: string[] = [];
      const walk = (d: string) => {
        for (const f of readdirSync(d)) {
          const p = join(d, f);
          if (statSync(p).isDirectory()) walk(p);
          else files.push(relative(outDir, p).split("\\").join("/"));
        }
      };
      walk(outDir);
      const assets = files.filter((f) => f !== "sw.js" && f !== "version.json").sort();
      const h = createHash("sha256");
      for (const f of assets) h.update(f).update(readFileSync(join(outDir, f)));
      const digest = h.digest("hex");
      writeFileSync(
        join(outDir, "version.json"),
        JSON.stringify(
          { version: VERSION, build: BUILD, commit: GIT_SHA, library: { version: libPkg.version, ref: LIB_REF }, assets_sha256: digest },
          null,
          2,
        ) + "\n",
      );
      const sw = readFileSync(new URL("./src/sw-template.js", import.meta.url), "utf8")
        .replace("__VERSION__", JSON.stringify(VERSION))
        .replace("__BUILD__", JSON.stringify(digest.slice(0, 16)))
        .replace("__ASSETS__", JSON.stringify(["./", ...assets.map((a) => `./${a}`)]));
      writeFileSync(join(outDir, "sw.js"), sw);
    },
  };
}

export default defineConfig({
  base: BASE,
  define: {
    __APP_VERSION__: JSON.stringify(VERSION),
    __APP_BUILD__: JSON.stringify(BUILD),
    __GIT_SHA__: JSON.stringify(GIT_SHA),
    __LIB_VERSION__: JSON.stringify(libPkg.version),
    __LIB_REF__: JSON.stringify(LIB_REF),
  },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@routstr/confidential-web"] },
  build: {
    target: "es2022",
    outDir: "dist",
    assetsInlineLimit: 0,
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5173 },
  plugins: [pwaRelease()],
});

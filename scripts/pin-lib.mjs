// Pin the library to a commit of github.com/jooray/routstr-confidential-web in
// package.json and package-lock.json:
//   node scripts/pin-lib.mjs <commit-sha>
// The commit must exist in the library's repository on GitHub (CI installs it
// from there): it is checked first, and nothing is rewritten if it is not found.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "https://github.com/jooray/routstr-confidential-web.git";
const sha = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(sha ?? "")) {
  console.error("usage: node scripts/pin-lib.mjs <40-hex commit>");
  process.exit(2);
}

const git = (args, opts = {}) => execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"], ...opts }).toString();

/** True when `sha` is in the library's repository: a branch or tag tip, or a commit a shallow fetch finds. */
function commitExists() {
  let refs;
  try {
    refs = git(["ls-remote", REPO]);
  } catch (e) {
    console.error(`cannot reach ${REPO} (git ls-remote failed): ${String(e.stderr ?? e.message).trim()}`);
    process.exit(1);
  }
  if (refs.split("\n").some((l) => l.startsWith(`${sha}\t`))) return true;
  // Not a ref tip: ask for the commit itself (GitHub serves any reachable commit by its id).
  const dir = mkdtempSync(join(tmpdir(), "pin-lib-"));
  try {
    git(["init", "--bare", "-q"], { cwd: dir });
    git(["fetch", "-q", "--depth=1", REPO, sha], { cwd: dir });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (!commitExists()) {
  console.error(`commit ${sha} is not in ${REPO}: push it first (nothing was changed)`);
  process.exit(1);
}

const spec = `git+${REPO}#${sha}`;
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.dependencies["@routstr/confidential-web"] = spec;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
lock.packages[""].dependencies["@routstr/confidential-web"] = spec;
lock.packages["node_modules/@routstr/confidential-web"].resolved = spec;
writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
console.log(`pinned @routstr/confidential-web to ${sha}`);

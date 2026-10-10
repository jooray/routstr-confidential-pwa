// Pin the library to a commit of github.com/jooray/routstr-confidential-web in
// package.json and package-lock.json (without network access to GitHub):
//   node scripts/pin-lib.mjs <commit-sha>
// After the library repository is public, `npm install
// github:jooray/routstr-confidential-web#<sha>` does the same.
import { readFileSync, writeFileSync } from "node:fs";
const sha = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error("usage: node scripts/pin-lib.mjs <40-hex commit>");
const spec = `github:jooray/routstr-confidential-web#${sha}`;
const resolved = `git+ssh://git@github.com/jooray/routstr-confidential-web.git#${sha}`;
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.dependencies["@routstr/confidential-web"] = spec;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
lock.packages[""].dependencies["@routstr/confidential-web"] = spec;
lock.packages["node_modules/@routstr/confidential-web"].resolved = resolved;
writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
console.log(`pinned @routstr/confidential-web to ${sha}`);

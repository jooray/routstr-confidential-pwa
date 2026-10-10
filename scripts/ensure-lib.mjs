// The library is a git dependency; npm builds its dist/ with `prepare` on
// install. Fail early with a clear message if that did not happen.
import { existsSync } from "node:fs";
const lib = new URL("../node_modules/@routstr/confidential-web/", import.meta.url).pathname;
if (!existsSync(`${lib}dist/index.js`) || !existsSync(`${lib}wasm/pkg/client_wasm_bg.wasm`)) {
  console.error(
    "@routstr/confidential-web is not built (dist/ or wasm/pkg/ missing). Reinstall with npm >= 10 so its `prepare` runs,\n" +
      "or for local development: npm run link-local (uses ../routstr-confidential-web).",
  );
  process.exit(1);
}

# routstr-confidential-pwa

A chat app (static PWA) for **routstr confidential mode**. The routstr node
relays your conversation with the LLM provider but cannot read it, and your
browser checks every step itself. Live at
**https://jooray.github.io/routstr-confidential-pwa/**. Introduction:
[Confidential inference on Routstr without trusted hardware](https://juraj.bednar.io/en/blog-en/2026/10/10/confidential-inference-on-routstr-without-trusted-hardware/)
(blog post).

For more depth, there is a programmer's guide, [How routstr confidential mode works](https://juraj.bednar.io/wp-content/uploads/2026/10/routstr-confidential-for-programmers.pdf) (PDF, 72 pages; in Slovak: [Ako funguje dôverný režim routstr](https://juraj.bednar.io/wp-content/uploads/2026/10/routstr-confidential-pre-programatorov.pdf)), and a gentler explanation of the protocol as a magic show, [Seven magic tricks inside one AI request](https://juraj.bednar.io/en/blog-en/2026/10/12/seven-magic-tricks-inside-one-ai-request/), with an illustrated video (in Slovak: [Sedem kúzelníckych trikov v jednej AI požiadavke](https://juraj.bednar.io/blog/2026/10/12/sedem-kuzelnickych-trikov-v-jednej-ai-poziadavke/)).

It is built on the library
[routstr-confidential-web](https://github.com/jooray/routstr-confidential-web).
The library runs protocol v2 (two-party TLS key schedule, zero-knowledge
proofs, signed receipts) in the page, with the cryptography in wasm in a Web
Worker. That README explains how a request works and the security model.

## What the app does

- **Chat with streaming answers.** The model list comes from the node's
  **signed** confidential offer (`/v1/confidential/offer`), with names and
  context sizes from `/v1/models`. Prices are never hard-coded.
- **Verification panel for every answer**:
  - The provider's certificate chain as your browser validated it: subject,
    SANs, issuers, validity, SPKI SHA-256, and the hostname match.
  - The TLS parameters: TLS 1.3, AES-128-GCM, and a P-256 joint key share from
    the 2PC.
  - The proofs: π_NK, π_C2S, π_C3S.
  - The node-signed attestation and receipt: usage, cost, the rates, and the
    signature.
  - Timings, cold or warm.
- **Wallet**:
  - Fund with **Lightning**: the node issues an invoice, with a QR code. A
    paid invoice creates or tops up your key.
  - Fund with **Cashu**: paste a token to create or top up an `sk-` key.
  - See your balance and reserved amount.
  - **Withdraw** the whole balance back to a Cashu token or a Lightning
    address, so you never strand sats.
  - Your key is kept in memory. It goes into `localStorage` only if you tick
    "Remember", with a warning.
- **Costs, in plain language**, all read from the signed offer:
  - The cost per message (usage × signed rates).
  - The balance each model needs: the node reserves the worst case while a
    request runs and releases the rest.
  - The fee for an unused prepared session (`abandon_fee_msat`; 2 sats on
    `routstr.cypherpunk.today`).
  - Any session fee or surcharge.
  - Mint input fees (`/v1/keysets` `input_fee_ppk`) and Lightning routing
    fees, shown where you fund or withdraw.
- **Pre-warming.** After the key is funded, one session is kept armed (2PC
  done) while the page is visible and you are active, so the first answer
  comes fast. It never arms without a balance. It does not arm if the node's
  unused-session fee is above 5 sats. You can turn it off.
- **Versioned releases with automatic update.** The page checks
  `version.json` on load, when it becomes visible, and every 5 minutes. On a
  new version the service worker updates and the page reloads by itself
  (after any answer in progress) and shows "Updated to vX". You never need a
  hard refresh. The footer shows the app version and commit, and the library
  version and commit, linked to the sources, so you can check what the page
  runs.

Defaults: node `https://routstr.cypherpunk.today`, pinned node key
`2ca46ee98f3134c4e11a638663a45983b590bfdefd31588f9c2f03455fba15e7`, trusted
provider `api.venice.ai`. You can change all three in the "Node" panel.

## Trust: you run the code this site serves

Confidential mode protects you from the node, not from whoever serves this
page. A malicious deploy could leak your prompt and your key. Check the
footer's commits against the sources and against `version.json`
(`assets_sha256` covers every built file). For stronger guarantees, build the
app yourself (below) and serve or open your own copy. The library README lists
the options: content-addressed releases, and a signed version manifest
(planned). Keep balances small. The CSP allows only this origin's scripts and
wasm, and network access only to `https:`/`wss:` (the node and mints you
choose).

## Build

```bash
npm ci            # installs @routstr/confidential-web from its pinned commit (git dependency; npm builds it)
npm run build     # → dist/ (static: index.html, sw.js, version.json, manifest, assets/)
npm run dev       # Vite dev server (no service worker in dev)
```

- `base` is `/routstr-confidential-pwa/` (GitHub Pages). For another path, set
  `BASE=/your/path/ npm run build`. The manifest, the service worker scope and
  every asset path are relative to it.
- **Release**: bump `version` in `package.json` and push to `main`.
  `.github/workflows/pages.yml` builds and deploys to Pages. Every build writes
  `dist/version.json` (`version`, `build`, `commit`, `library`,
  `assets_sha256`) and a per-release `dist/sw.js`, whose cache is named after
  the version and lists the exact assets. Serve `sw.js` and `version.json`
  uncached (the page also fetches them with `no-store`).
- **Library version**: `node scripts/pin-lib.mjs <commit>` pins
  `@routstr/confidential-web` to a commit of routstr-confidential-web in
  `package.json` and `package-lock.json`. For local development against a
  checkout next to this one, run `npm run link-local`.

## Tests

```bash
npx playwright install chromium     # once
npm run build
node scripts/e2e-prod.mjs smoke     # production node, no money: signed offer verified, models and prices,
                                    # service worker and version.json, an invalid key refused at setup
node scripts/update-test.mjs        # automatic update: build A, open, build B, page reloads into B with the notice
CONF_TEST_KEY=sk-… node scripts/e2e-prod.mjs live 2
                                    # funded key from the environment (never logged): one cold request,
                                    # then pre-warmed ones; prints verified timings, proofs, receipt, certificate
```

`ENGINE=firefox` or `ENGINE=webkit` selects another browser.

## License

MIT

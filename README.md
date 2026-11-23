# routstr-confidential-pwa

A chat app (static PWA) for **routstr confidential mode**. The routstr node
relays your conversation with the LLM provider but cannot read it, and your
browser checks every step itself. Live at
**https://jooray.github.io/routstr-confidential-pwa/**. Introduction:
[Confidential inference on Routstr without trusted hardware](https://juraj.bednar.io/en/blog-en/2026/10/10/confidential-inference-on-routstr-without-trusted-hardware/)
(blog post).

To try it (this app, routstrd, the libraries, or your own node), read the
[testing guide](https://jooray.github.io/routstr-confidential-pwa/testing/)
(source: `public/testing/index.html`).

For more depth, there is a programmer's guide, [How routstr confidential mode works](https://juraj.bednar.io/wp-content/uploads/2026/10/routstr-confidential-for-programmers.pdf) (PDF, 72 pages; in Slovak: [Ako funguje dôverný režim routstr](https://juraj.bednar.io/wp-content/uploads/2026/10/routstr-confidential-pre-programatorov.pdf)), and a gentler explanation of the protocol as a magic show, [Seven magic tricks inside one AI request](https://juraj.bednar.io/en/blog-en/2026/10/12/seven-magic-tricks-inside-one-ai-request/), with an illustrated video (in Slovak: [Sedem kúzelníckych trikov v jednej AI požiadavke](https://juraj.bednar.io/blog/2026/10/12/sedem-kuzelnickych-trikov-v-jednej-ai-poziadavke/)).

It is built on the library
[routstr-confidential-web](https://github.com/jooray/routstr-confidential-web).
The library runs protocol v3 (connections carrying requests, the two-party
TLS key schedule `split-public-3`, zero-knowledge proofs, signed receipts) in
the page, with the cryptography in wasm in a Web Worker. That README explains
how a connection and its requests work and the security model. It needs a
node on protocol v3: a node that still offers v2 is shown as "node outdated"
with a banner, and no request is sent to it.

## What the app does

- **Chat with streaming answers.** The model list comes from the node's
  **signed** confidential offer (`/v1/confidential/offer`), with names and
  context sizes from `/v1/models`. Prices are never hard-coded.
- **Verification panel for every answer**:
  - The provider's certificate chain as your browser validated it: subject,
    SANs, issuers, validity, SPKI SHA-256, and the hostname match.
  - The TLS parameters: TLS 1.3, AES-128-GCM, a P-256 joint key share from
    the 2PC, and the ALPN (`h2` or `http/1.1`).
  - The proofs: π_NK (once per connection), π_WIN (the request's records),
    π_C3S (the usage disclosure).
  - The connection: HTTP/2 or HTTP/1.1 to the provider, the request's number
    on its connection, and whether it ran on a kept, a prepared or a new
    connection (also on each answer's line).
  - The node-signed attestation and receipt: usage, cost, the rates, the
    session fee (once per connection), the connection deposit and what
    became of it, and the signature.
  - Timings, cold or warm.
- **Wallet**:
  - Fund with **Lightning**: the node issues an invoice, with a QR code. A
    paid invoice creates or tops up your key.
  - Fund with **Cashu**: paste a token to create or top up an `sk-` key.
  - See your balance and reserved amount (requests in flight and connection
    deposits).
  - **Withdraw** the whole balance back to a Cashu token or a Lightning
    address, so you never strand sats.
  - Your key is kept in memory. It goes into `localStorage` only if you tick
    "Remember on this device" (off by default), with a warning. Closing a
    tab that holds a funded, unremembered key asks for confirmation.
- **Costs, in plain language**, all read from the signed offer:
  - The cost per message (usage × signed rates).
  - The balance each model needs: the node reserves the worst case while a
    request runs and releases the rest; a new connection also reserves the
    connection deposit (`connection_deposit_msat`), released by its first
    answer.
  - What an unused prepared connection costs: its deposit.
  - Any session fee (once per connection) or surcharge.
  - Mint input fees (`/v1/keysets` `input_fee_ppk`) and Lightning routing
    fees, shown where you fund or withdraw.
- **Image generation** through the same confidential connections (models,
  variants and per-image prices from the signed offer; on demand, never
  pre-armed). Generated images are re-encoded in the browser (no provider
  metadata kept) and kept in this browser's IndexedDB **together with their
  prompt, model and receipt**, so the gallery survives a reload. That copy of
  the prompt is local and unencrypted; delete images from the gallery (or
  clear the site's data) to remove it.
- **Image input** for vision models (the node's model list says which; the
  **Image** button, or paste an image). The image is downscaled to at most
  1568 px, re-encoded as JPEG and sent as a data URI inside the encrypted
  request, so the node never sees it and no image host is contacted. The
  provider bills it as input tokens, which the receipt shows; it is re-sent
  (and billed again) with every later message in the same chat.
- **HTTP/2 to the provider** (Node panel: auto, HTTP/2 only, or HTTP/1.1 =
  HTTP/2 off). With HTTP/2 one connection, and one two-party handshake,
  serves your next messages while you keep chatting (the node closes it
  after its idle time), so later answers start in well under a second. The
  provider can tell those messages come from one client, as it can for one
  API key. HTTP/1.1 opens a connection per message. The header shows which
  one the next message uses; a node whose HTTP/2 fails to open falls back to
  HTTP/1.1 for 10 minutes.
- **Pre-warming** (off by default; on HTTP/2 the open connection already stays
  warm between messages). When turned on, after your first answer with a funded key, one connection
  is kept prepared (2PC done, no provider connection yet) while the page is
  visible and you are active, when no connection is open, so the next
  message after a pause skips the two-party preparation. It never arms
  without a balance for the deposit plus one message. It does not arm if the
  node's connection deposit (what an unused prepared connection costs) is
  above 5 sats.
- **Versioned releases with automatic update.** The page checks
  `version.json` on load, when it becomes visible, and every 5 minutes. On a
  new version the service worker updates and the page reloads by itself
  (after any answer in progress) and shows "Updated to vX". You never need a
  hard refresh. The footer shows the app version and commit, and the library
  version and commit, linked to the sources, so you can check what the page
  runs.

A node on an onion service can be reached as `http://<name>.onion` (the
page's CSP allows plain `http:`/`ws:` only to `.onion` hosts and localhost),
which works in Tor Browser.

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
node scripts/wallet-test.mjs        # fake nodes: keys per node URL, one poll per invoice, a different paid key
                                    # offered not swapped, withdraw waits for reserved = 0, an update reload
                                    # keeps the in-memory key/token/invoices, oversized body refused
node scripts/image-ui-test.mjs      # fake node: image mode controls and setup
CONF_TEST_KEY=sk-… node scripts/e2e-prod.mjs live 2
                                    # funded key from the environment (never logged): one cold request,
                                    # then pre-warmed ones; prints verified timings, proofs, receipt, certificate
```

`ENGINE=firefox` or `ENGINE=webkit` selects another browser.

## License

MIT

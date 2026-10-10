// Markdown rendering safety and basics, in a real browser.  node scripts/md-test.mjs
import { chromium } from "playwright";
import { PREFIX, serveDist } from "./serve-dist.mjs";
const server = await serveDist(4174);
const browser = await chromium.launch();
const page = await browser.newPage();
const fired = [];
page.on("dialog", (d) => { fired.push(d.message()); d.dismiss(); });
await page.goto(`http://127.0.0.1:4174${PREFIX}`);
await page.waitForFunction(() => typeof window.__rc?.renderMarkdown === "function" || (window.__rc ??= undefined, false), null, { timeout: 15000 }).catch(() => {});
await page.evaluate(() => { if (!window.__rc?.renderMarkdown) throw new Error("hook missing"); });
const cases = {
  script: "hi <script>alert(1)</script>",
  onerror: '<img src=x onerror="alert(2)">',
  jslink: "[click](javascript:alert(3))",
  datalink: "[x](data:text/html,<script>alert(4)</script>)",
  image: "![tracker](https://example.com/pixel.png)",
  rawlink: "see https://example.com/page",
  basics: "# Title\n\n**bold** _it_ `code`\n\n- a\n- b\n\n1. one\n\n> quote\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```",
  partial: "Here is code:\n\n```py\nprint(",
};
let failed = 0;
const check = (name, cond, html) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) { failed++; console.log("     " + html); } };
for (const [name, md] of Object.entries(cases)) {
  const html = await page.evaluate((t) => window.__rc.renderMarkdown(t), md);
  // also mount it, so any active content would actually run
  await page.evaluate((h) => { const d = document.createElement("div"); d.innerHTML = h; document.body.append(d); }, html);
  if (name === "script") check("script tag not rendered", !/<script/i.test(html), html);
  if (name === "onerror") check("raw HTML escaped, no img/onerror", !/<img/i.test(html) && !/onerror=/i.test(html.replace(/&lt;[^]*?&gt;/g, "")), html);
  if (name === "jslink") check("javascript: link not a link", !/href="javascript/i.test(html), html);
  if (name === "datalink") check("data: link not a link", !/href="data:/i.test(html), html);
  if (name === "image") check("remote image dropped", !/<img/i.test(html), html);
  if (name === "rawlink") check("bare URL linked, new tab, no referrer", /<a href="https:\/\/example.com\/page" target="_blank" rel="noopener noreferrer nofollow">/.test(html), html);
  if (name === "basics") check("headings, emphasis, code, lists, quote, table, fenced code", ["<h1>", "<strong>", "<em>", "<code>", "<ul>", "<ol>", "<blockquote>", "<table>", "<pre>"].every((t) => html.includes(t)), html);
  if (name === "partial") check("unfinished fenced block renders", /<pre>/.test(html), html);
}
await page.waitForTimeout(500);
check("no script ran (no dialogs)", fired.length === 0, JSON.stringify(fired));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);

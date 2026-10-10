// Basic markdown for model answers, rendered as they stream.
//
// Model output is untrusted and this page holds a bearer key, so: raw HTML in
// the markdown is not rendered (markdown-it `html: false` escapes it), the
// result is sanitised again with DOMPurify against a small allowlist, links
// only go to http(s)/mailto and open in a new tab without a referrer, and
// images are dropped (a remote image would let an answer make the browser
// contact a third party; the CSP blocks them as well).

import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
md.validateLink = (url: string) => /^(https?:|mailto:)/i.test(url.trim());

const ALLOWED_TAGS = [
  "p", "br", "strong", "em", "del", "s", "code", "pre", "blockquote",
  "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "a",
  "table", "thead", "tbody", "tr", "th", "td",
];

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer nofollow");
  }
});

/** Sanitised HTML for a (possibly partial) markdown answer. */
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(md.render(text), {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "target", "rel", "start", "align"],
    ALLOW_DATA_ATTR: false,
  });
}

/**
 * A target element that re-renders its markdown at most once per animation
 * frame, so long streams stay cheap.
 */
export function streamingMarkdown(el: HTMLElement): { set(text: string): void; flush(): void } {
  let pending: string | undefined;
  let scheduled = false;
  const paint = () => {
    scheduled = false;
    if (pending === undefined) return;
    el.innerHTML = renderMarkdown(pending);
    pending = undefined;
  };
  return {
    set(text: string) {
      pending = text;
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(paint);
      }
    },
    flush: paint,
  };
}

import DOMPurify from "dompurify";
import { parseCidSrc } from "./cid";
import { isRemoteHttpUrl, rewriteCssHttpUrls } from "./remote-url";
import { isQuoteDividerText } from "./quote-boundary";

export interface ProcessedEmail {
  /** Sanitized, gated, quote-trimmed HTML for the visible message body. */
  mainHtml: string;
  /** The collapsed quoted-history HTML, or null if no boundary was found. */
  quotedHtml: string | null;
  /** True if the source referenced at least one remote (http) image. */
  hadRemoteImage: boolean;
}

export interface ProcessOptions {
  /**
   * The proxied src of a remote image, or `null` while the user has not opted
   * into "Display images" for this message (every remote src is stripped). A
   * remote image it answers `null` for (the proxy is unavailable on this host)
   * is stripped too.
   */
  remoteImageSrc: ((remoteUrl: string) => string | null) | null;
  resolveCid?: (cid: string) => string | undefined;
}

// DOMPurify configuration. Its default regex already blocks `javascript:` /
// `vbscript:` and every event-handler attribute (`onclick`, …). On top of that:
//   - FORBID_TAGS drops active/interactive/embedding elements and `<style>`
//     (whose CSS could carry tracking `url()`s our gate never sees; DOMPurify
//     drops its *content* too, since `style` is in its FORBID_CONTENTS set).
//   - FORBID_ATTR drops `srcset` so a responsive candidate can't smuggle an
//     un-gated remote URL past the `src`-only image walk.
//   - ADD_ATTR keeps `target` so the post-sanitize link rewrite survives.
//   - ALLOWED_URI_REGEXP is DOMPurify's default minus the extra schemes, and
//     critically WITHOUT a `data:` allowance — inline `data:` sources are
//     blocked (defense-in-depth against `data:image/svg+xml`). `data:` images
//     that slip through the tag-level allowlist are dropped again in the walk.
const PURIFY_CONFIG = {
  FORBID_TAGS: [
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "form",
    "input",
    "button",
    "textarea",
    "select",
    "option",
    "link",
    "meta",
    "base",
    "noscript",
  ],
  FORBID_ATTR: ["srcset"],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ["target"],
  ALLOWED_URI_REGEXP:
    /^(?:(?:https?|mailto|tel|cid):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  RETURN_DOM: true,
};

/**
 * Full client-side email-HTML pipeline: sanitize → image-gate + cid-resolve →
 * quoted-history split. Returns serialized HTML strings for the component to
 * inject. Pure w.r.t. React — needs a DOM (DOMPurify), so it is exercised by the
 * component's jsdom test rather than a `bun:test`.
 */
export function processEmailHtml(
  html: string,
  { remoteImageSrc, resolveCid }: ProcessOptions,
): ProcessedEmail {
  const root = DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as HTMLElement;

  // Links: force external opening + a privacy-preserving rel.
  for (const a of Array.from(root.querySelectorAll("a"))) {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer nofollow");
  }

  let hadRemoteImage = false;

  // Images: resolve cid: parts, block data:/remote unless opted in.
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";

    const cid = parseCidSrc(src);
    if (cid !== null) {
      const resolved = resolveCid?.(cid);
      if (resolved) {
        img.setAttribute("src", resolved);
      } else {
        // Not-yet-available (attachment still hydrating): leave a placeholder.
        // The component re-runs when resolveCid changes, filling it in later.
        img.removeAttribute("src");
        img.setAttribute("data-cid", cid);
      }
      continue;
    }

    if (/^\s*data:/i.test(src)) {
      // Block inline data: images (belt-and-suspenders vs data:image/svg+xml).
      img.removeAttribute("src");
      img.setAttribute("data-blocked-src", src);
      continue;
    }

    if (isRemoteHttpUrl(src)) {
      hadRemoteImage = true;
      const proxied = remoteImageSrc?.(src) ?? null;
      if (proxied !== null) {
        img.setAttribute("src", proxied);
      } else {
        img.removeAttribute("src");
        img.setAttribute("data-blocked-src", src);
      }
    }
  }

  // Inline style url()s (CSS background images — a common tracking vector).
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[style]"))) {
    const style = el.getAttribute("style") ?? "";
    if (!/url\(/i.test(style)) continue;
    let sawRemote = false;
    const rewritten = rewriteCssHttpUrls(style, (u) => {
      sawRemote = true;
      return remoteImageSrc?.(u) ?? null;
    });
    if (sawRemote) {
      hadRemoteImage = true;
      el.setAttribute("style", rewritten);
    }
  }

  const { mainHtml, quotedHtml } = splitQuoted(root);
  return { mainHtml, quotedHtml, hadRemoteImage };
}

/**
 * Split the sanitized body at the first quoted-reply boundary. Everything from
 * the boundary's top-level ancestor onward is removed from the main body and
 * returned as `quotedHtml`; the rest stays as `mainHtml`.
 */
function splitQuoted(root: HTMLElement): {
  mainHtml: string;
  quotedHtml: string | null;
} {
  const boundary = findBoundary(root);
  if (!boundary) return { mainHtml: root.innerHTML, quotedHtml: null };

  // Climb to the boundary's top-level ancestor (a direct child of root) so we
  // trim whole sibling blocks, not a node buried inside the visible content.
  let node: Element = boundary;
  while (node.parentElement && node.parentElement !== root) {
    node = node.parentElement;
  }
  if (node.parentElement !== root) {
    return { mainHtml: root.innerHTML, quotedHtml: null };
  }

  const quotedParts: string[] = [];
  const toRemove: Element[] = [];
  for (let cur: Element | null = node; cur; cur = cur.nextElementSibling) {
    quotedParts.push(cur.outerHTML);
    toRemove.push(cur);
  }
  for (const el of toRemove) el.remove();

  return { mainHtml: root.innerHTML, quotedHtml: quotedParts.join("") };
}

/** The earliest quoted-history boundary element in document order, or null. */
function findBoundary(root: HTMLElement): Element | null {
  const structural = root.querySelector(".gmail_quote, blockquote");

  let divider: Element | null = null;
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (el.tagName === "BLOCKQUOTE") continue; // covered by `structural`
    const txt = (el.textContent ?? "").trim();
    if (txt.length > 400) continue; // a wrapper of the whole quote — skip
    if (isQuoteDividerText(txt)) {
      divider = el;
      break;
    }
  }

  if (structural && divider) {
    // Keep whichever appears first in the document.
    const rel = structural.compareDocumentPosition(divider);
    return rel & Node.DOCUMENT_POSITION_PRECEDING ? divider : structural;
  }
  return structural ?? divider;
}

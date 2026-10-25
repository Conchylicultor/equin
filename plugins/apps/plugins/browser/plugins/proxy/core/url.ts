/**
 * Pure helpers + cross-runtime protocol for the in-app browser proxy. A leaf
 * (imports only the product-name leaf) so both the webview consumer and the server handler can depend on
 * it downward without forming a cycle.
 */

import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";

/**
 * Route path of the framing-stripping browser proxy. MUST stay in sync with the
 * route in `../shared/endpoints.ts` (`GET /api/browser/proxy`).
 */
export const BROWSER_PROXY_PATH = "/api/browser/proxy";

/**
 * Wrap a target URL so the in-app browser loads it through the proxy (which
 * strips `X-Frame-Options` / CSP `frame-ancestors` so framing-blocked sites
 * render). Returns a same-origin relative URL.
 */
export function proxyUrl(target: string): string {
  return `${BROWSER_PROXY_PATH}?url=${encodeURIComponent(target)}`;
}

/**
 * True when `src` points at the proxy. Proxied content is served from our own
 * origin, so the webview must render it in an opaque sandbox (drop
 * `allow-same-origin`) — see the security model in the design doc. `proxyUrl`
 * always emits a relative path starting with `BROWSER_PROXY_PATH`, so a prefix
 * check is sufficient (no URL parsing).
 */
export function isProxyUrl(src: string): boolean {
  return src.startsWith(BROWSER_PROXY_PATH);
}

/**
 * postMessage protocol: the script the proxy injects into framed pages posts
 * this to its parent on an intercepted same-frame navigation (link click / GET
 * form submit). The webview listens and routes it through the normal
 * `navigate()` so the omnibox + history stay in sync and the page reloads
 * through the proxy exactly once.
 */
export const BROWSER_PROXY_NAV_MESSAGE = `${LEGACY_IDS.browserKeyPrefix}:browser-proxy-nav`;

/**
 * The kind of in-page navigation the proxied page is reporting:
 * - `navigate` — parent-driven load (link click, GET form). Parent pushes a
 *   history entry and (re)loads the iframe.
 * - `newtab` — `window.open` / `target="_blank"`. Parent opens a new tab.
 * - `commit` — the iframe finished loading a full document at `url`
 *   (`document.baseURI` = the post-redirect final URL). Reconciles redirects +
 *   POST landings.
 * - `sync` — in-page SPA URL change (`pushState`/`replaceState`/`popstate`).
 *   Omnibox-display only; no reload, no history entry.
 */
export type BrowserProxyNavKind = "navigate" | "newtab" | "commit" | "sync";

const NAV_KINDS: readonly BrowserProxyNavKind[] = [
  "navigate",
  "newtab",
  "commit",
  "sync",
];

export interface BrowserProxyNavMessage {
  type: typeof BROWSER_PROXY_NAV_MESSAGE;
  /** Which navigation the proxied page is reporting. */
  kind: BrowserProxyNavKind;
  /** Absolute target URL (real origin) the proxied page wants to navigate to. */
  url: string;
}

/**
 * A declarative refresh redirect parsed from a `<meta http-equiv="refresh">`
 * `content` attribute or an HTTP `Refresh` response header.
 */
export interface MetaRefreshDirective {
  /** Delay before the navigation, in milliseconds (0 = immediate). */
  delayMs: number;
  /** The (possibly relative) target URL — resolve against the document base. */
  url: string;
}

/**
 * Parse a refresh `content` value (`"<delay>; url=<target>"`) shared by
 * `<meta http-equiv="refresh">` and the HTTP `Refresh` header.
 *
 * Returns `null` for a bare delay with no `url=` (a same-document reload — the
 * proxied document just re-fetches itself, so there is nothing to redirect).
 * The returned `url` is left untouched (possibly relative); the caller resolves
 * it against the real document base. A leaf pure function so the server handler
 * can depend on it and it stays unit-testable.
 */
export function parseMetaRefresh(content: string): MetaRefreshDirective | null {
  if (!content) return null;
  const semi = content.indexOf(";");
  const delayPart = (semi === -1 ? content : content.slice(0, semi)).trim();
  const delaySec = Number.parseFloat(delayPart);
  const delayMs =
    Number.isFinite(delaySec) && delaySec > 0 ? Math.round(delaySec * 1000) : 0;
  if (semi === -1) return null; // bare delay → same-document reload, not ours.

  const rest = content.slice(semi + 1).trim();
  const match = /url\s*=\s*(.*)$/i.exec(rest);
  if (!match || match[1] === undefined) return null;
  let url = match[1].trim();
  // Strip a single layer of matching surrounding quotes (`url='...'`).
  if (
    url.length >= 2 &&
    ((url.startsWith('"') && url.endsWith('"')) ||
      (url.startsWith("'") && url.endsWith("'")))
  ) {
    url = url.slice(1, -1).trim();
  }
  if (!url) return null;
  return { delayMs, url };
}

/** Narrow an untrusted `message` event payload to a nav message, else null. */
export function parseBrowserProxyNavMessage(
  data: unknown,
): BrowserProxyNavMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.type !== BROWSER_PROXY_NAV_MESSAGE) return null;
  if (typeof m.url !== "string" || m.url === "") return null;
  // `kind` defaults to "navigate" for robustness (missing/invalid field).
  const kind =
    typeof m.kind === "string" && NAV_KINDS.includes(m.kind as BrowserProxyNavKind)
      ? (m.kind as BrowserProxyNavKind)
      : "navigate";
  return { type: BROWSER_PROXY_NAV_MESSAGE, kind, url: m.url };
}

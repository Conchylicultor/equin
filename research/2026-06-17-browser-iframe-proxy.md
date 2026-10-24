# Browser app: server-side framing-stripping proxy

## Problem

The browser app (`plugins/apps/plugins/browser`) renders pages in an `<iframe src={url}>`.
Sites that send `X-Frame-Options` or CSP `frame-ancestors` (most major sites, search
engines) render blank — they can only be opened in the system browser. A server-side
proxy that fetches the page, strips the framing headers, and keeps navigation inside the
proxy makes the in-app browser genuinely useful.

Security-sensitive: SSRF, cookie/session handling, and serving foreign HTML from our own
origin.

## Design

### Request path

Iframe `src` becomes `/api/browser/proxy?url=<encoded target>` when **proxy mode** is on
(default ON). The server handler:

1. Parses + SSRF-guards the target (`infra/safe-fetch`, new primitive).
2. Fetches it server-side, following redirects manually with per-hop SSRF revalidation.
3. Strips framing/credential headers from the response (`x-frame-options`,
   `content-security-policy[-report-only]`, `set-cookie`, `strict-transport-security`,
   `cross-origin-*-policy`, `clear-site-data`).
4. For `text/html`: streams through Bun's `HTMLRewriter`, injecting into `<head>`:
   - `<base href="<final URL after redirects>">` so every relative/asset/JS-relative URL
     resolves to the **real origin** and loads directly (no per-asset proxying needed).
   - a small **nav-interception script**: intercepts same-frame `<a>` clicks and GET-form
     submits, computes the absolute target against the base, and `postMessage`s it to the
     parent (`singularity:browser-proxy-nav`). The proxied page never self-navigates.
   - For non-HTML: streams the body through unchanged (only headers stripped).
5. On fetch/SSRF/timeout failure: returns a small friendly HTML error page (expected
   condition for a user-typed URL — not a crash report).

### Why `<base>` + parent-driven navigation (not full URL rewriting)

`<base href=finalUrl>` makes the browser resolve **all** subresources (img/script/link/css,
and JS `fetch`/`new URL` via `document.baseURI`, including absolute-path `/foo`) against the
real origin — so assets load directly, no server load, no CSS/srcset rewriting. The only
thing that must stay inside the proxy is **document navigation** (clicking a link would
otherwise leave the proxy and hit the framing block again). We handle that by intercepting
clicks in the injected script and routing them through the parent's existing `navigate()`,
which updates the omnibox + history + reloads the iframe through the proxy exactly once.

Known limitation: JS-driven navigation (`location=`, `history.pushState`, `window.open`),
and POST forms aren't intercepted — they fall back to opening the real URL (may re-block).
Documented; advanced interception (service-worker rewrite, POST proxying) is a follow-up.

### Security model (critical)

Proxied content is served from **our** gateway origin. If the iframe kept
`allow-same-origin`, the foreign page's JS would be same-origin with the equin app and
could reach `window.parent`. **Rule:** the iframe drops `allow-same-origin` whenever its
`src` is same-origin (i.e. proxied) — proxied content runs in an opaque, isolated origin
(`allow-scripts allow-forms allow-popups` only). Cross-origin direct loads keep
`allow-same-origin` (so a directly-embedded site is same-origin with *itself*). This rule
lives in the webview and needs no knowledge of the proxy beyond `isProxyUrl(src)`.

Other mitigations: SSRF guard with DNS resolution + per-hop redirect revalidation; **no
cookie forwarding** (anonymous fetches), `set-cookie` stripped (proxy can't carry sessions —
acceptable: login flows are out of scope); request timeout + body cap.

Residual risk: DNS-rebinding TOCTOU (we resolve+check then fetch by hostname). Acceptable
for a single-user localhost dev tool; IP-pinned connect is a follow-up.

## Module layout

```
plugins/apps/plugins/browser/plugins/proxy/
  core/        proxyUrl(), isProxyUrl(), BROWSER_PROXY_PATH, nav postMessage protocol
  shared/      defineEndpoint("GET /api/browser/proxy")  (raw handler, no codec)
  server/      handler: safe-fetch + header strip + HTMLRewriter base/script injection
  web/         proxy-mode toggle button (Browser.Actions)

plugins/infra/plugins/safe-fetch/   NEW primitive: SSRF-guarded fetch (DNS + per-hop)
```

Edits to existing browser sub-plugins (all sibling sub-plugins of the browser app, not
load-bearing cross-app infra):

- **shell/nav-store**: add `proxyEnabled` to `BrowserTabsState` + `useBrowserProxy()`
  ({enabled, toggle}). Natural owner of per-surface browser session state; no dep on proxy.
- **webview/viewport**: src = `enabled && url ? proxyUrl(url) : url`; sandbox drops
  `allow-same-origin` when `isProxyUrl(src)`; `message` listener → `navigate()` on
  `singularity:browser-proxy-nav` from the active iframe. (webview → proxy/core: a small
  leaf dep.)

## Follow-ups (file as tasks)

- Migrate `page/bookmark/server/internal/scrape.ts` SSRF helpers to `infra/safe-fetch`
  (remove the duplicate hostname-only guard).
- IP-pinned connect to close the DNS-rebinding TOCTOU window.
- Per-tab proxy toggle (currently per-surface global) + persistence.
- Advanced in-page nav interception (JS nav, POST forms) via injected runtime shim.

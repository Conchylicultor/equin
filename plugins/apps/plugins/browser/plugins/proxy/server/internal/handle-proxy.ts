import {
  SsrfError,
  safeFetch,
} from "@plugins/infra/plugins/safe-fetch/server";
import { readHtmlAttr } from "@plugins/infra/plugins/html-decode/core";
import {
  BROWSER_PROXY_NAV_MESSAGE,
  BROWSER_PROXY_PATH,
  parseMetaRefresh,
} from "../../core";

const PROXY_TIMEOUT_MS = 20_000;

/**
 * Realistic desktop UA so sites serve their normal HTML (some gate on bot-like
 * agents). We fetch anonymously — no cookies — so this is just for compatibility.
 */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Escape a string for safe interpolation into a double-quoted HTML attribute. */
function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

/** Resolve a (possibly relative) URL against `base`, keeping only http(s). */
function resolveHttp(raw: string, base: string): string | null {
  try {
    const u = new URL(raw, base);
    return /^https?:$/i.test(u.protocol) ? u.href : null;
  } catch (err) {
    // `new URL` throws TypeError for a malformed/relative-without-base input —
    // expected for arbitrary upstream refresh targets. Anything else is real.
    if (err instanceof TypeError) return null;
    throw err;
  }
}

/**
 * A `<script>` calling the injected refresh scheduler. `JSON.stringify` makes
 * the URL a safe JS string literal; we additionally escape `<` to `<` so a
 * URL containing `</script>` can never break out of the script element.
 */
function scheduleRefreshScript(delayMs: number, absUrl: string): string {
  const urlLiteral = JSON.stringify(absUrl).replaceAll("<", "\\u003c");
  return `<script>window.__equinProxyScheduleRefresh(${delayMs},${urlLiteral})</script>`;
}

/**
 * Script injected into proxied HTML. Runs inside the sandboxed, opaque-origin
 * iframe (no `allow-same-origin`), so it cannot reach the parent's DOM — only
 * `postMessage`. It intercepts in-page navigations and routes them to the parent
 * via typed `kind` messages (navigate / newtab / commit / sync), keeping the
 * omnibox + history in sync and reflecting redirects / SPA URL changes. POST
 * forms are rewritten to submit through the proxy natively. Asset/JS subresources
 * are untouched — they resolve directly against the real origin via the injected
 * `<base>`, which is injected BEFORE this script so `document.baseURI` is already
 * the final (post-redirect) URL when this runs.
 */
const NAV_SCRIPT = `(function () {
  var NAV = ${JSON.stringify(BROWSER_PROXY_NAV_MESSAGE)};
  var PROXY_PATH = ${JSON.stringify(BROWSER_PROXY_PATH)};
  function post(url, kind) {
    try {
      parent.postMessage({ type: NAV, kind: kind, url: url }, "*");
    } catch (e) {}
  }
  function isHttp(u) {
    try {
      return /^https?:$/i.test(new URL(u).protocol);
    } catch (e) {
      return false;
    }
  }
  // The opaque-origin sandbox reports location.origin as "null"; rebuild the
  // proxy origin from protocol + host, which stay readable to the frame.
  function proxyOrigin() {
    return location.protocol + "//" + location.host;
  }

  // Report the committed document URL (post-redirect final URL via <base>).
  post(document.baseURI, "commit");

  // Declarative refresh redirects (<meta http-equiv=refresh> / Refresh header)
  // are rewritten server-side into a call to this scheduler so they route
  // through the same parent-driven \`navigate\` path as link clicks instead of
  // navigating the iframe straight to the (un-proxied) real origin. The URL is
  // already absolute (resolved server-side against the real document base).
  window.__equinProxyScheduleRefresh = function (delayMs, url) {
    try {
      if (!isHttp(url)) return;
      setTimeout(function () {
        post(url, "navigate");
      }, delayMs > 0 ? delayMs : 0);
    } catch (e) {}
  };

  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href");
    if (!href) return;
    var trimmed = href.trim();
    if (trimmed === "" || trimmed.charAt(0) === "#") return;
    if (/^javascript:/i.test(trimmed)) return;
    var abs;
    try {
      abs = new URL(href, document.baseURI).href;
    } catch (err) {
      return;
    }
    if (!isHttp(abs)) return;
    if (a.target && a.target.toLowerCase() === "_blank") {
      e.preventDefault();
      post(abs, "newtab");
      return;
    }
    e.preventDefault();
    post(abs, "navigate");
  }, true);

  document.addEventListener("submit", function (e) {
    if (e.defaultPrevented) return;
    var form = e.target;
    if (!form) return;
    var method = form.method ? form.method.toLowerCase() : "get";
    var action = form.getAttribute("action") || document.baseURI;
    var abs;
    try {
      abs = new URL(action, document.baseURI);
    } catch (err) {
      return;
    }
    if (!/^https?:$/i.test(abs.protocol)) return;
    var blank = form.target && form.target.toLowerCase() === "_blank";

    if (method === "get") {
      try {
        var data = new FormData(form);
        var params = new URLSearchParams();
        data.forEach(function (value, key) {
          if (typeof value === "string") params.append(key, value);
        });
        abs.search = params.toString();
      } catch (err) {
        return;
      }
      e.preventDefault();
      post(abs.href, blank ? "newtab" : "navigate");
      return;
    }

    // Non-GET (POST etc.): rewrite the action to the proxy route and let the
    // native submit proceed so the body (url-encoded / multipart) is preserved.
    form.action =
      proxyOrigin() + PROXY_PATH + "?url=" + encodeURIComponent(abs.href);
    if (blank) form.target = "_self";
  }, true);

  // SPA routing: report pushState/replaceState as display-only syncs, but ONLY
  // for RELATIVE url args. \`window.location\` inside the iframe is the proxy URL
  // (not the real one), so any absolute url a site derives from \`location\` would
  // leak the internal proxy URL into the omnibox. Relative urls resolve against
  // <base> (the real origin), so they are the only trustworthy signal; absolute
  // urls and \`popstate\` (which can only read the proxy \`location\`) are ignored —
  // the omnibox then keeps the reliable \`commit\` value (document.baseURI).
  function isAbsolute(u) {
    return /^[a-z][a-z0-9+.-]*:/i.test(u) || u.indexOf("//") === 0;
  }
  function wrapHistory(name) {
    var orig = history[name];
    if (typeof orig !== "function") return;
    history[name] = function (state, title, url) {
      var ret = orig.apply(this, arguments);
      try {
        if (typeof url === "string" && url !== "" && !isAbsolute(url)) {
          var real = new URL(url, document.baseURI).href;
          if (isHttp(real)) post(real, "sync");
        }
      } catch (e) {}
      return ret;
    };
  }
  wrapHistory("pushState");
  wrapHistory("replaceState");

  // window.open: there's no live handle in the sandbox; surface as a new tab.
  try {
    window.open = function (url) {
      try {
        if (url) {
          var abs = new URL(url, document.baseURI).href;
          if (isHttp(abs)) post(abs, "newtab");
        }
      } catch (e) {}
      return null;
    };
  } catch (e) {}
})();`;

/** Small, self-contained styled HTML error page (no external assets). */
function errorPage(status: number, target: string, detail: string): Response {
  const safeTarget = escapeAttribute(target);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Page couldn't be loaded</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f5f5f5;
    color: #1a1a1a;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #e5e5e5; }
    .card { background: #242424; border-color: #333; }
    .detail { color: #999; }
    .url { color: #aaa; }
  }
  .card {
    max-width: 28rem;
    margin: 1.5rem;
    padding: 2rem;
    background: #fff;
    border: 1px solid #e0e0e0;
    border-radius: 12px;
    text-align: center;
  }
  h1 { font-size: 1.125rem; margin: 0 0 0.5rem; }
  .detail { font-size: 0.875rem; color: #666; margin: 0 0 1rem; }
  .url {
    font-size: 0.8125rem;
    color: #555;
    word-break: break-all;
    margin: 0 0 1rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .hint { font-size: 0.8125rem; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <h1>This page couldn't be loaded</h1>
    <p class="detail">${escapeAttribute(detail)}</p>
    <p class="url">${safeTarget}</p>
    <p class="hint">Try opening it in your system browser.</p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Framing-stripping browser proxy. Fetches the target server-side (SSRF-guarded,
 * anonymous), strips framing/credential headers, and — for HTML — injects a
 * `<base>` + nav-interception script so the page renders inside the in-app
 * browser and navigations route back through the proxy.
 *
 * Raw handler (no `implement()`): it streams the upstream body, so it has no
 * response codec. A user-typed URL that fails (bad host, timeout, network
 * error) is an EXPECTED condition — we return a friendly error page, never a
 * crash report. Only unexpected errors propagate.
 *
 * Headers are built fresh via an allowlist (content-type, content-disposition,
 * accept-ranges, content-range, plus our own cache-control) — never copied from
 * upstream. This unconditionally drops every header that would re-block or
 * leak: `x-frame-options`, `content-security-policy[-report-only]`, `set-cookie`,
 * `strict-transport-security`, `cross-origin-{opener,embedder,resource}-policy`,
 * `clear-site-data`, and `content-encoding` / `content-length` (Bun's fetch
 * already decodes the body, and the length changes after HTML rewrite).
 */
export async function handleProxy(req: Request): Promise<Response> {
  const target = new URL(req.url).searchParams.get("url");
  if (!target || target.trim() === "") {
    return errorPage(400, "", "No URL was provided to load.");
  }

  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
  };
  // Forward Range so media (audio/video/large files) can be seeked.
  const range = req.headers.get("range");
  if (range) headers.range = range;

  // POST (rewritten form submits): forward the method + body + Content-Type so
  // url-encoded and multipart/file uploads are preserved. The body is buffered
  // (not streamed) so it survives `safeFetch`'s redirect re-issue. GET keeps the
  // original behavior.
  const isPost = req.method === "POST";
  // `ArrayBuffer`, not the DOM `BodyInit`: that is precisely what `req.arrayBuffer()`
  // returns, and the wider annotation only forced a needless mismatch against
  // `SafeFetchInit.body`.
  let body: ArrayBuffer | undefined;
  if (isPost) {
    const contentType = req.headers.get("content-type");
    if (contentType) headers["content-type"] = contentType;
    body = await req.arrayBuffer();
  }

  let res: Response;
  try {
    res = await safeFetch(target, {
      headers,
      method: isPost ? "POST" : "GET",
      body,
      timeoutMs: PROXY_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof SsrfError) {
      return errorPage(400, target, "This address can't be loaded for security reasons.");
    }
    // fetch throws (DNS failure, connection refused, timeout/abort) for any
    // network-level problem — all expected for a user-typed URL. TypeError and
    // AbortError/DOMError are the documented fetch failure modes; anything else
    // is unexpected and must propagate as a real crash.
    if (
      err instanceof TypeError ||
      (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"))
    ) {
      return errorPage(502, target, "The site didn't respond or couldn't be reached.");
    }
    throw err;
  }

  const upstreamType = res.headers.get("content-type") ?? "";

  // Curated response headers — built fresh, never copied wholesale from upstream.
  const out = new Headers();
  if (upstreamType) out.set("content-type", upstreamType);
  out.set("cache-control", "no-store");
  forwardIfPresent(res.headers, out, "content-disposition");
  forwardIfPresent(res.headers, out, "accept-ranges");
  forwardIfPresent(res.headers, out, "content-range");

  if (!upstreamType.startsWith("text/html")) {
    // Non-HTML (assets, media, downloads): stream through unchanged.
    return new Response(res.body, { status: res.status, headers: out });
  }

  // The final URL after redirects — used as the <base> so every relative asset /
  // JS-relative URL resolves to the real origin and loads directly.
  const finalUrl = res.url || target;
  const baseTag = `<base href="${escapeAttribute(finalUrl)}">`;
  let injection = `${baseTag}<script>${NAV_SCRIPT}</script>`;

  // HTTP `Refresh` response header → schedule a proxied navigate. (We never
  // forward the raw header — it would navigate the iframe to the un-proxied real
  // origin and re-hit the framing block.) Resolved against finalUrl up front.
  const refreshHeader = res.headers.get("refresh");
  if (refreshHeader) {
    const directive = parseMetaRefresh(refreshHeader);
    const abs = directive && resolveHttp(directive.url, finalUrl);
    if (directive && abs) injection += scheduleRefreshScript(directive.delayMs, abs);
  }

  let injected = false;
  const rewriter = new HTMLRewriter()
    .on("head", {
      element(el) {
        if (injected) return; // only the first <head> gets the injection.
        injected = true;
        el.prepend(injection, { html: true });
      },
    })
    // <meta http-equiv="refresh" content="…; url=…"> would otherwise navigate
    // the iframe straight to the real origin (un-proxied). Replace it with a
    // call to the injected scheduler so it routes through the proxy navigate
    // path. A bare-delay reload (no url=) is left untouched — it just re-fetches
    // the current proxied document.
    //
    // Read through `readHtmlAttr`: the rewriter hands attributes back as raw
    // markup source, so `content="0;url=https://x/?a=1&amp;b=2"` would otherwise
    // parse into a URL carrying a literal `&amp;` — a different query string
    // than the page meant.
    .on("meta", {
      element(el) {
        const httpEquiv = readHtmlAttr(el, "http-equiv");
        if (!httpEquiv || httpEquiv.trim().toLowerCase() !== "refresh") return;
        const directive = parseMetaRefresh(readHtmlAttr(el, "content") ?? "");
        if (!directive) return;
        const abs = resolveHttp(directive.url, finalUrl);
        if (!abs) return;
        el.replace(scheduleRefreshScript(directive.delayMs, abs), { html: true });
      },
    });

  // Buffer the rewritten HTML rather than streaming `transformed.body`: piping
  // an HTMLRewriter transform stream over the gateway's unix socket truncates
  // for large documents (the gateway sees "unexpected EOF"). HTML responses are
  // bounded, so a full buffer + explicit content-length is both robust and lets
  // the gateway frame the response correctly. Non-HTML still streams (above).
  const html = await rewriter.transform(res).text();
  return new Response(html, { status: res.status, headers: out });
}

function forwardIfPresent(src: Headers, dst: Headers, name: string): void {
  const value = src.get(name);
  if (value !== null) dst.set(name, value);
}

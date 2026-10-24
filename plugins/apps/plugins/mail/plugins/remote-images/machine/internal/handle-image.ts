import { SsrfError, safeFetch } from "@plugins/infra/plugins/safe-fetch/server";

const IMAGE_TIMEOUT_MS = 15_000;

/**
 * SSRF-guarded, image-content-type-restricted proxy for remote email images.
 *
 * Raw handler (no `implement()`): it streams the upstream image bytes through
 * unchanged, so it has no JSON response codec. A user-opened email pointing at
 * a dead/blocked host is an EXPECTED condition — we map it to a 4xx/5xx status,
 * never a crash report. Only genuinely-unexpected errors propagate.
 *
 * This is the ONLY path by which a remote email image ever loads, and only
 * AFTER the user opts into "Display images". Two invariants keep it from being
 * abused:
 *   - `safeFetch` blocks loopback/private/link-local/metadata targets (SSRF).
 *   - the upstream `content-type` must start with `image/`, else 415 — so the
 *     route can never be used as a generic open proxy for arbitrary bytes.
 *
 * Response headers are built fresh from an allowlist (never copied wholesale
 * from upstream) so no upstream `set-cookie` / caching / security header leaks
 * through to the browser.
 */
export async function handleMailImage(req: Request): Promise<Response> {
  const target = new URL(req.url).searchParams.get("url");
  if (!target || target.trim() === "") {
    return new Response("missing url", { status: 400 });
  }

  let res: Response;
  try {
    res = await safeFetch(target, { timeoutMs: IMAGE_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof SsrfError) {
      return new Response("blocked", { status: 400 });
    }
    // fetch throws TypeError (DNS failure, connection refused) or
    // AbortError/TimeoutError for any network-level problem — all expected for
    // a remote host we don't control. Anything else is unexpected: rethrow.
    if (
      err instanceof TypeError ||
      (err instanceof Error &&
        (err.name === "AbortError" || err.name === "TimeoutError"))
    ) {
      return new Response("upstream unreachable", { status: 502 });
    }
    throw err;
  }

  const upstreamType = res.headers.get("content-type") ?? "";
  if (!upstreamType.toLowerCase().startsWith("image/")) {
    // Refuse to proxy non-image bytes: keeps this from being an open proxy.
    return new Response("not an image", { status: 415 });
  }

  // Curated response headers — built fresh, never copied wholesale from upstream.
  const out = new Headers();
  out.set("content-type", upstreamType);
  const contentLength = res.headers.get("content-length");
  if (contentLength !== null) out.set("content-length", contentLength);
  out.set("cache-control", "private, max-age=86400");

  return new Response(res.body, { status: res.status, headers: out });
}

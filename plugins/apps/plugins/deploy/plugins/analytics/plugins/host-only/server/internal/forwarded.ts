import type { HttpHandler } from "@plugins/framework/plugins/server-core/core";
import { HOST_ONLY_PREFIX } from "../../core";

/**
 * The proxy chain in front of a deployed backend, and the ONE place that knows it.
 *
 *   visitor ──▶ Caddy ──▶ gateway (127.0.0.1:<port>) ──▶ backend (unix socket)
 *
 * - Caddy's `reverse_proxy` treats every client as untrusted (no
 *   `trusted_proxies` in the generated site block), so it REPLACES any
 *   client-supplied `X-Forwarded-For` with the one address it saw.
 * - The gateway is an `httputil.ReverseProxy` in Director mode
 *   (`gateway/worktree.go` `newReverseProxy`), which APPENDS its own peer —
 *   Caddy, on loopback — to the header.
 *
 * So a public request reaches the backend with exactly two hops
 * (`<visitor>, 127.0.0.1`), while a request made on the box straight to the
 * gateway's loopback port (an SSH `curl`, the activate script's health gate,
 * or local dev through `*.localhost:<port>`) carries exactly one.
 */

/** The `X-Forwarded-For` entries, outermost first. Empty when the header is absent. */
export function forwardedHops(header: string | null): string[] {
  if (header === null) return [];
  return header
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
}

/**
 * The visitor's address: the entry Caddy wrote, second-to-last. A single hop
 * means nothing stood in front of the gateway (on-box request or local dev),
 * so that hop IS the client.
 *
 * Throws when the header is absent: every request the gateway proxies carries
 * it, so its absence means the backend was reached some other way and the
 * chain this function encodes no longer holds.
 */
export function clientIpFromHops(hops: string[]): string {
  if (hops.length === 0) {
    throw new Error(
      "requestClientIp: request has no X-Forwarded-For — it did not come through the gateway, so the proxy chain is unknown",
    );
  }
  return hops.length === 1 ? hops[0]! : hops[hops.length - 2]!;
}

export function requestClientIp(req: Request): string {
  return clientIpFromHops(forwardedHops(req.headers.get("x-forwarded-for")));
}

/** True iff the request made exactly the gateway's own hop — it came from the box. */
export function isHostLocalRequest(req: Request): boolean {
  return forwardedHops(req.headers.get("x-forwarded-for")).length === 1;
}

/**
 * Wrap a route so it answers only requests made on the box. Anything else gets
 * the same bare 404 an unknown route gets, so the route's existence is not
 * advertised. This is the SECOND guard: the generated Caddy block already
 * refuses `/api/host-only/*` publicly.
 *
 * Wrapping a route outside {@link HOST_ONLY_PREFIX} throws on the first
 * request: that route would be missing the Caddy guard, and a single guard is
 * not what this wrapper promises.
 */
export function hostOnly(handler: HttpHandler): HttpHandler {
  return (req, params) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (!pathname.startsWith(HOST_ONLY_PREFIX)) {
      throw new Error(
        `hostOnly: route ${pathname} is outside ${HOST_ONLY_PREFIX}, so Caddy does not block it publicly — move it under the prefix`,
      );
    }
    if (!isHostLocalRequest(req)) {
      return new Response("Not found", { status: 404 });
    }
    return handler(req, params);
  };
}

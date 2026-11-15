/**
 * Who issued a page-origin request, stamped on it as a header the server
 * ignores: `page` (the page's own code — its chrome, its telemetry) or
 * `scope:<id>` (code inside a plugin scope whose subtree reached the page's
 * transport — a scope with a server of its own, like the website's live demo,
 * must never). Read by e2e to tell a page's own request from a scope's
 * leak: one document holds both, so a request's origin cannot say who sent it.
 */
export const REQUEST_ISSUER_HEADER = "X-Equin-Issuer";

/** A request issuer as {@link REQUEST_ISSUER_HEADER} spells it. */
export type RequestIssuer = "page" | `scope:${string}`;

/** The page's own code. */
export const PAGE_ISSUER: RequestIssuer = "page";

/** Code inside the plugin scope `scopeId`. */
export function scopeIssuer(scopeId: string): RequestIssuer {
  return `scope:${scopeId}`;
}

/** The issuer a header value names, or `null` when it names none. */
export function parseRequestIssuer(
  value: string | null | undefined,
): RequestIssuer | null {
  if (value === PAGE_ISSUER) return PAGE_ISSUER;
  if (value?.startsWith("scope:") === true && value.length > "scope:".length)
    return value as RequestIssuer;
  return null;
}

/**
 * The headers naming the page as a request's issuer — for a request the page
 * sends before any transport exists (an inline head script's t0 fetch).
 */
export function pageIssuerHeaders(): Record<string, string> {
  return { [REQUEST_ISSUER_HEADER]: PAGE_ISSUER };
}

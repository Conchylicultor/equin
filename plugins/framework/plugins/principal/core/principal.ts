import { z } from "zod";

/**
 * The header the gateway stamps on every request it proxies to a socket host
 * (HTTP and WebSocket alike), after deleting any value the client sent: the
 * edge's verdict on who is calling. Lowercase here (Fetch `Headers` are
 * case-insensitive); the gateway's Go constant (`principalHeader` in
 * `gateway/principal.go`) is pinned to it by the `principal:header-in-sync`
 * check.
 */
export const PRINCIPAL_HEADER = "x-equin-principal";

/**
 * Who a request is, as the edge decided it. `owner`: the person this instance
 * belongs to — their own pages (same-origin), a typed URL, or a local tool
 * (the CLI, MCP, a script: no browser headers at all). `anonymous`: anyone
 * else — another site, a sibling namespace, an opaque origin, a DNS-rebound
 * host. Hosted widens it (a device, an agent, a share link).
 */
export type Principal =
  { kind: "owner" } | { kind: "anonymous" } | { kind: "content" };

const OWNER: Principal = { kind: "owner" };
const ANONYMOUS: Principal = { kind: "anonymous" };
const CONTENT: Principal = { kind: "content" };

/**
 * The principal a request carries. Exactly `owner` → owner; exactly `content`
 * → content (a request on the content host, `<item>.content.localhost` — never
 * the owner); anything else — a missing header included — is anonymous. Fail
 * closed: a request that did not come through the gateway was not vouched for
 * by it.
 */
export function principalOf(req: Request): Principal {
  const stamp = req.headers.get(PRINCIPAL_HEADER);
  if (stamp === "owner") return OWNER;
  if (stamp === "content") return CONTENT;
  return ANONYMOUS;
}

/**
 * Who may call a route. `"owner"` is the default — never written in a
 * declaration, it is what an endpoint without `access` is. `{ public }` lets
 * an anonymous caller in, and says why (the reason is what a reviewer reads):
 * `defineEndpoint({ …, access: { public: "<reason>" } })`. `{ content }`
 * serves the route ONLY on the content host (`<item>.content.localhost`), to
 * untrusted content framed off the app origin — `item` names the route param
 * whose value is the content's origin key (one origin per piece of content).
 */
export type EndpointAccess =
  "owner" | { public: string } | { content: string; item: string };

const REFUSED_STATUS = 403;

const refusedBody = z.object({
  reason: z.literal("cross-site-refused"),
  route: z.string(),
  message: z.string(),
});

/** The sentence a refused caller reads — the gateway's own, word for word. */
export const CROSS_SITE_REFUSED_MESSAGE =
  "A request from another site is not the owner; equin refused it before it ran.";

/**
 * `403 { reason: "cross-site-refused", route, message }` — the same body the
 * gateway answers its own refusals with (`writeCrossSiteRefusal`).
 */
export function crossSiteRefusedResponse(route: string): Response {
  return Response.json(
    {
      reason: "cross-site-refused",
      route,
      message: CROSS_SITE_REFUSED_MESSAGE,
    } satisfies z.infer<typeof refusedBody>,
    { status: REFUSED_STATUS },
  );
}

/** The sentence an app-origin caller of a content route reads. */
export const CONTENT_ONLY_MESSAGE =
  "This route serves untrusted content; it answers only on its content host (<item>.content.localhost), never on an app origin.";

/**
 * `403 { reason: "content-only", route, message }` — a content route asked
 * for on an app origin, where its document would run as the owner.
 */
export function contentOnlyResponse(route: string): Response {
  return Response.json(
    { reason: "content-only", route, message: CONTENT_ONLY_MESSAGE },
    { status: REFUSED_STATUS },
  );
}

/** Whether a response's status and parsed body are the cross-site refusal. */
export function isCrossSiteRefusal(status: number, body: unknown): boolean {
  return status === REFUSED_STATUS && refusedBody.safeParse(body).success;
}

/**
 * Whether a browser sent this request at all — any browser, the owner's own
 * page included. Browsers always send `Sec-Fetch-*` (and `Origin` on a
 * write) and cannot suppress them; a local tool sends none. For the rare route
 * no page may read even as the owner (a response carrying secret values):
 * that is a narrower rule than the principal, and it lives here so the request
 * headers it reads are read in one place (`principal/no-origin-header-read`).
 */
export function isBrowserRequest(req: Request): boolean {
  for (const name of req.headers.keys()) {
    const lower = name.toLowerCase();
    if (lower === "origin" || lower.startsWith("sec-fetch-")) return true;
  }
  return false;
}

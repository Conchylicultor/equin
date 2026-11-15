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
 * The values the gateway stamps under {@link PRINCIPAL_HEADER}, one per
 * principal kind. Pinned to the gateway's Go constants (`principalOwner`, …
 * in `gateway/principal.go`) by the `principal:header-in-sync` check: a stamp
 * the hosts do not know reads as anonymous (fail closed).
 */
export const PRINCIPAL_STAMPS = {
  owner: "owner",
  anonymous: "anonymous",
  visitor: "visitor",
  content: "content",
} as const;

/**
 * Who a request is, as the edge decided it. `owner`: the person this instance
 * belongs to — their own pages (same-origin), a typed URL, or a local tool
 * (the CLI, MCP, a script: no browser headers at all) on this machine.
 * `visitor`: anyone who came through a deployed site's public edge (Caddy) —
 * a stranger on the internet, on the site's own origin; never the owner,
 * whatever headers they send. `anonymous`: anyone else — another site, a
 * sibling namespace, an opaque origin, a DNS-rebound host. `content`: a
 * request on the content host. Hosted widens it (a device, an agent, a share
 * link).
 */
export type Principal = { kind: keyof typeof PRINCIPAL_STAMPS };

const OWNER: Principal = { kind: "owner" };
const ANONYMOUS: Principal = { kind: "anonymous" };
const VISITOR: Principal = { kind: "visitor" };
const CONTENT: Principal = { kind: "content" };

/**
 * The principal a request carries. Exactly `owner` → owner; exactly `visitor`
 * → visitor (through a deployed site's public edge — never the owner);
 * exactly `content` → content (a request on the content host,
 * `<item>.content.localhost` — never the owner); anything else — a missing
 * header included — is anonymous. Fail closed: a request that did not come
 * through the gateway was not vouched for by it.
 */
export function principalOf(req: Request): Principal {
  const stamp = req.headers.get(PRINCIPAL_HEADER);
  if (stamp === PRINCIPAL_STAMPS.owner) return OWNER;
  if (stamp === PRINCIPAL_STAMPS.visitor) return VISITOR;
  if (stamp === PRINCIPAL_STAMPS.content) return CONTENT;
  return ANONYMOUS;
}

/**
 * Who may call a route. `"owner"` is the default — never written in a
 * declaration, it is what an endpoint without `access` is. `{ public }` lets
 * an anonymous caller in, and says why (the reason is what a reviewer reads):
 * `defineEndpoint({ …, access: { public: "<reason>" } })`. `{ visitor }`
 * serves the owner and a deployed site's visitors (anyone through its public
 * edge), never a foreign page: what every page of a deployed site boots and
 * reports through (the live-state read and socket, the log sink, served
 * assets) — not a cross-site reader of the owner's own machine. `{ content }`
 * serves the route ONLY on the content host (`<item>.content.localhost`), to
 * untrusted content framed off the app origin — `item` names the route param
 * whose value is the content's origin key (one origin per piece of content).
 */
export type EndpointAccess =
  | "owner"
  | { public: string }
  | VisitorAccess
  | { content: string; item: string };

/**
 * The one opt-in that serves a deployed site's visitors as well as the owner,
 * with why: an endpoint's, a socket's (`SocketAccess`) and a live resource's
 * (`liveValue` / `liveCollection`'s `access`) — each owner-only without it.
 */
export type VisitorAccess = { visitor: string };

/**
 * Whether a caller may reach a route of this access — the one rule every
 * host's gate (HTTP routes and WebSocket upgrades alike) applies. A content
 * route's refusal of the owner is a distinct answer, left to the gate.
 */
export function admits(access: EndpointAccess, caller: Principal): boolean {
  if (access === "owner") return caller.kind === "owner";
  if ("public" in access) return true;
  if ("visitor" in access) {
    return caller.kind === "owner" || caller.kind === "visitor";
  }
  return caller.kind === "content";
}

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

/**
 * The sentence an app-origin caller of a content route reads: where the route
 * answers instead — the exact URL when the gate could derive it (the request's
 * namespace host and the route's item param), else the host pattern.
 */
export function contentOnlyMessage(contentUrl: string | null): string {
  const head =
    "This route serves untrusted content; it answers only on its content host, never on an app origin.";
  return contentUrl === null
    ? `${head} Load it on <item>.content.localhost/<namespace>/… instead.`
    : `${head} Load it at ${contentUrl}`;
}

/**
 * `403 { reason: "content-only", route, url, message }` — a content route
 * asked for on an app origin, where its document would run as the owner.
 * `url` is the same request on its content host (null when the request's
 * host names no namespace, e.g. a local tool on the raw socket).
 */
export function contentOnlyResponse(
  route: string,
  contentUrl: string | null,
): Response {
  return Response.json(
    {
      reason: "content-only",
      route,
      url: contentUrl,
      message: contentOnlyMessage(contentUrl),
    },
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

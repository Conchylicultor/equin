import { z } from "zod";
import {
  CONTENT_ITEM_RE,
  contentUrl,
  namespaceFromHost,
} from "@plugins/infra/plugins/namespace/core";
import {
  admits,
  contentOnlyResponse,
  crossSiteRefusedResponse,
  principalOf,
  type EndpointAccess,
  type VisitorAccess,
} from "./principal";
import { readPrincipalStamp, UNSTAMPED_GATEWAY_WARNING } from "./stamp";

/**
 * A socket host's route handler, as the gate reads it: the endpoints primitive
 * attaches the route's resolved `access` to every handler it builds
 * (`implement`, `implementMachine`, `rawEndpointHandler`, `machineHandler`). A
 * handler without one — a core-owned raw route, a central handler not built by
 * endpoints — is `owner`.
 */
export type GatedRouteHandler = ((
  req: Request,
  params: Record<string, string>,
) => Response | Promise<Response>) & { readonly access?: EndpointAccess };

/** A route's access as the gate resolves it: absent is `owner`. */
export function accessOf(handler: GatedRouteHandler): EndpointAccess {
  return handler.access ?? "owner";
}

/**
 * The same request on its content host
 * (`http://<item>.content.localhost:<port>/<label><path>?<query>`), so the
 * content-only refusal names the exact URL to load instead. `null` when the
 * request's host names no namespace (a local tool on the raw socket, a public
 * host) or the item param is not one DNS label — nothing to derive it from.
 */
function contentUrlFor(req: Request, item: string | undefined): string | null {
  const url = new URL(req.url);
  // The gateway addresses the backend as "backend" and hands the host the
  // visitor typed over as X-Forwarded-Host (always its own word: a client's
  // value is overwritten — `gateway/worktree.go`).
  const host = req.headers.get("x-forwarded-host") ?? url.host;
  const ns = namespaceFromHost(host);
  if (ns === null || item === undefined || !CONTENT_ITEM_RE.test(item)) {
    return null;
  }
  if (!url.pathname.startsWith("/api/")) return null;
  const portMatch = /:(\d+)$/.exec(host);
  const port = portMatch ? Number(portMatch[1]) : 80;
  return contentUrl(item, ns, `${url.pathname}${url.search}`, port);
}

/**
 * Every route behind the principal gate, decided once per route at
 * registration: a `{ public }` route is passed through untouched; any other
 * answers an anonymous request with `403 cross-site-refused` before its
 * handler runs (so before any side effect). Mounted by the two socket hosts
 * (server-core's and central-core's `bin/index.ts`) — never by the in-realm
 * browser host, whose only caller is the page itself.
 */
export function gateByPrincipal(
  routes: Iterable<readonly [string, GatedRouteHandler]>,
): Array<[string, GatedRouteHandler]> {
  const out: Array<[string, GatedRouteHandler]> = [];
  for (const [route, handler] of routes) {
    const access = accessOf(handler);
    if (typeof access === "object" && "public" in access) {
      out.push([route, handler]);
      continue;
    }
    const gated: GatedRouteHandler =
      typeof access === "object" && "content" in access
        ? // Content: served only on the content host. On an app origin its
          // document would run as the owner; anonymous is anyone else.
          (req, params) => {
            const kind = principalOf(req).kind;
            if (kind === "content") return handler(req, params);
            return kind === "owner"
              ? contentOnlyResponse(
                  route,
                  contentUrlFor(req, params[access.item]),
                )
              : crossSiteRefusedResponse(route);
          }
        : (req, params) =>
            admits(access, principalOf(req))
              ? handler(req, params)
              : crossSiteRefusedResponse(route);
    out.push([route, gated]);
  }
  return out;
}

/**
 * Who may open a socket: the owner (the default, absent on a handler), or the
 * owner and a deployed site's visitors (`{ visitor: "<reason>" }`). No socket
 * is public or content: WebSockets are not bound by the same-origin policy,
 * so a foreign page could otherwise read all live state.
 */
export type SocketAccess = "owner" | VisitorAccess;

/**
 * A WebSocket upgrade's answer before `server.upgrade`: the refusal for a
 * caller the socket's access does not admit — anonymous and content always, a
 * visitor unless the socket says why it serves one — `null` to proceed. The
 * gateway refuses an anonymous upgrade first; this is the host's own floor.
 */
export function refuseUnadmittedUpgrade(
  req: Request,
  path: string,
  access: SocketAccess = "owner",
): Response | null {
  return admits(access, principalOf(req))
    ? null
    : crossSiteRefusedResponse(`WS ${path}`);
}

/** One row of a socket host's route table (`GET /api/host/routes`). */
export const HostRouteSchema = z.object({
  route: z.string(),
  kind: z.enum(["http", "ws"]),
  access: z.enum(["owner", "public", "visitor", "content"]),
  /** Why the route is public / visitor / content; absent on an owner route. */
  reason: z.string().optional(),
});
export type HostRoute = z.infer<typeof HostRouteSchema>;

/**
 * A socket host's route table, as its routes endpoint answers it: whether the
 * gate is on (`stamped` — the gateway declared it stamps the principal; when
 * false every route is served ungated, see `./stamp.ts`), and every route.
 */
export const HostRouteTableSchema = z.object({
  stamped: z.boolean(),
  routes: z.array(HostRouteSchema),
});
export type HostRouteTable = z.infer<typeof HostRouteTableSchema>;

/** The server-core socket host's route table route. */
export const HOST_ROUTES_ROUTE = "GET /api/host/routes";
/**
 * Central's twin of {@link HOST_ROUTES_ROUTE}, on a path of its own so the
 * gateway's central-routes manifest (written from central's route keys) sends
 * it to central and no worktree route shadows it.
 */
export const CENTRAL_HOST_ROUTES_ROUTE = "GET /api/central/host/routes";

function routeRow(
  route: string,
  kind: HostRoute["kind"],
  access: EndpointAccess,
): HostRoute {
  if (access === "owner") return { route, kind, access: "owner" };
  if ("public" in access) {
    return { route, kind, access: "public", reason: access.public };
  }
  if ("visitor" in access) {
    return { route, kind, access: "visitor", reason: access.visitor };
  }
  return { route, kind, access: "content", reason: access.content };
}

/** The table of a host's HTTP and WebSocket routes, with each one's access. */
export function hostRouteTable(
  http: Iterable<readonly [string, GatedRouteHandler]>,
  ws: Iterable<readonly [string, SocketAccess]>,
): HostRoute[] {
  const rows: HostRoute[] = [];
  for (const [route, handler] of http) {
    rows.push(routeRow(route, "http", accessOf(handler)));
  }
  // No socket is public: every upgrade is refused to an anonymous caller.
  for (const [path, access] of ws) rows.push(routeRow(path, "ws", access));
  return rows;
}

/**
 * A socket host's principal gate — what both socket hosts mount, built once
 * from whether their gateway stamps the principal.
 *
 * - `stamped`: every HTTP route behind `gateByPrincipal`, every WebSocket
 *   upgrade behind `refuseUnadmittedUpgrade`.
 * - not stamped (a gateway older than the stamp): every route served ungated —
 *   a fail-closed gate would refuse every request, the gateway's own readiness
 *   probe included. The route table says so (`stamped: false`).
 */
export interface HostGate {
  readonly stamped: boolean;
  /**
   * The host's HTTP routes, with its own route-table route (`tableRoute`,
   * owner-only) added, gated when stamped.
   */
  routes(opts: {
    tableRoute: string;
    http: Iterable<readonly [string, GatedRouteHandler]>;
    ws: Iterable<readonly [string, SocketAccess]>;
  }): Array<[string, GatedRouteHandler]>;
  /** The refusal for a WebSocket upgrade, `null` to proceed. */
  refuseUpgrade(
    req: Request,
    path: string,
    access: SocketAccess | undefined,
  ): Response | null;
}

export function hostGate(stamped: boolean): HostGate {
  return {
    stamped,
    routes(opts) {
      const http: Array<readonly [string, GatedRouteHandler]> = [...opts.http];
      const ws = [...opts.ws];
      let table: HostRouteTable | null = null;
      const tableHandler: GatedRouteHandler = () => {
        table ??= { stamped, routes: hostRouteTable(all, ws) };
        return Response.json(table);
      };
      const all = [...http, [opts.tableRoute, tableHandler] as const];
      return stamped
        ? gateByPrincipal(all)
        : all.map(([route, handler]) => [route, handler]);
    },
    refuseUpgrade: (req, path, access) =>
      stamped ? refuseUnadmittedUpgrade(req, path, access) : null,
  };
}

/**
 * The socket host's gate, from its argv: reads (and records) the gateway's
 * `--principal-stamped` declaration, and logs loudly — non-fatally — when it
 * is missing. Called once by each socket host's entry point.
 */
export function hostGateFromArgv(argv: readonly string[]): HostGate {
  const stamped = readPrincipalStamp(argv);
  if (!stamped) console.error(`[principal] ${UNSTAMPED_GATEWAY_WARNING}`);
  return hostGate(stamped);
}

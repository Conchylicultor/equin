import { z } from "zod";
import {
  crossSiteRefusedResponse,
  principalOf,
  type EndpointAccess,
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
    if (typeof accessOf(handler) === "object") {
      out.push([route, handler]);
      continue;
    }
    const gated: GatedRouteHandler = (req, params) =>
      principalOf(req).kind === "anonymous"
        ? crossSiteRefusedResponse(route)
        : handler(req, params);
    out.push([route, gated]);
  }
  return out;
}

/**
 * A WebSocket upgrade's answer before `server.upgrade`: the refusal for an
 * anonymous request (no socket is public — WebSockets are not bound by the
 * same-origin policy, so a foreign page could otherwise read all live state),
 * `null` to proceed. The gateway refuses these first; this is the host's own
 * floor.
 */
export function refuseAnonymousUpgrade(
  req: Request,
  path: string,
): Response | null {
  return principalOf(req).kind === "anonymous"
    ? crossSiteRefusedResponse(`WS ${path}`)
    : null;
}

/** One row of a socket host's route table (`GET /api/host/routes`). */
export const HostRouteSchema = z.object({
  route: z.string(),
  kind: z.enum(["http", "ws"]),
  access: z.enum(["owner", "public"]),
  /** Why the route is public; absent on an owner route. */
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

/** The table of a host's HTTP and WebSocket routes, with each one's access. */
export function hostRouteTable(
  http: Iterable<readonly [string, GatedRouteHandler]>,
  wsPaths: Iterable<string>,
): HostRoute[] {
  const rows: HostRoute[] = [];
  for (const [route, handler] of http) {
    const access = accessOf(handler);
    rows.push(
      typeof access === "object"
        ? { route, kind: "http", access: "public", reason: access.public }
        : { route, kind: "http", access: "owner" },
    );
  }
  // No socket is public: every upgrade is refused to an anonymous caller.
  for (const path of wsPaths) {
    rows.push({ route: path, kind: "ws", access: "owner" });
  }
  return rows;
}

/**
 * A socket host's principal gate — what both socket hosts mount, built once
 * from whether their gateway stamps the principal.
 *
 * - `stamped`: every HTTP route behind `gateByPrincipal`, every WebSocket
 *   upgrade behind `refuseAnonymousUpgrade`.
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
    wsPaths: Iterable<string>;
  }): Array<[string, GatedRouteHandler]>;
  /** The refusal for a WebSocket upgrade, `null` to proceed. */
  refuseUpgrade(req: Request, path: string): Response | null;
}

export function hostGate(stamped: boolean): HostGate {
  return {
    stamped,
    routes(opts) {
      const http: Array<readonly [string, GatedRouteHandler]> = [...opts.http];
      const wsPaths = [...opts.wsPaths];
      let table: HostRouteTable | null = null;
      const tableHandler: GatedRouteHandler = () => {
        table ??= { stamped, routes: hostRouteTable(all, wsPaths) };
        return Response.json(table);
      };
      const all = [...http, [opts.tableRoute, tableHandler] as const];
      return stamped
        ? gateByPrincipal(all)
        : all.map(([route, handler]) => [route, handler]);
    },
    refuseUpgrade: (req, path) =>
      stamped ? refuseAnonymousUpgrade(req, path) : null,
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

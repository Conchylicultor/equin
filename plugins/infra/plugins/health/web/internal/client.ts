import {
  sendEndpointRequest,
  readEndpointResponse,
  type RequestFetch,
} from "@plugins/infra/plugins/endpoints/core";
import { pageTransport } from "@plugins/primitives/plugins/networking/plugins/page-transport/web";
import {
  getHealth as getHealthEndpoint,
  type HealthResponse,
} from "../../core";

// Page-level health: probes the page's own server. It must answer while the
// live socket is wedged (the wedge watchdog asks it), so it is the transport's
// raw fetch rather than a live read — kept on the contract: the request built
// and the reply decoded by the endpoint's own codec.
export async function getHealth(
  signal?: AbortSignal,
): Promise<HealthResponse | null> {
  try {
    return await readEndpointResponse(
      getHealthEndpoint,
      await sendEndpointRequest(
        pageTransport.fetch,
        getHealthEndpoint,
        {},
        {
          signal,
        },
      ),
    );
  // eslint-disable-next-line promise-safety/no-bare-catch, promise-safety/no-absorbed-failure -- health probe intentionally swallows all errors (network down, server not started, abort) and returns null; any propagation here would be wrong since callers use null to mean "unreachable"
  } catch {
    return null;
  }
}

/**
 * Whether the page's host answers HTTP right now, asked of its health route:
 *
 * - `answered` — any HTTP answer, 2xx or not (`health` is the decoded body of
 *   a 2xx, null for a non-2xx: the host is reachable, its server is not well);
 * - `no-answer` — the request got no HTTP answer at all (fetch's network
 *   error): the visitor's network, or the path to the host, is down — or the
 *   whole host is. The page cannot tell those apart.
 *
 * A live-state wedge is a fault of the live-state path on a host that
 * otherwise answers. A page that cannot reach its host at all is not looking
 * at one: a laptop whose network dropped, a train through a tunnel. Its
 * reports were only ever delivered after the network came back, describing an
 * outage of the visitor's link as a wedge of ours (equin.ai, 2026-11-18
 * 00:31–00:35 UTC: a visitor's tab lost the box for 4 minutes — every
 * handshake hung, every fetch failed — while the box's network, server and
 * jobs ran on; three wedge reports landed 1 s after its socket reopened).
 *
 * No deadline: an answer decides, and a request that hangs decides nothing —
 * a hung host could not take the report either.
 */
export type HostReach =
  | { kind: "answered"; status: number; health: HealthResponse | null }
  | { kind: "no-answer" };

export async function reachHostOver(send: RequestFetch): Promise<HostReach> {
  let res: Response;
  try {
    res = await sendEndpointRequest(send, getHealthEndpoint, {});
  } catch (err) {
    // fetch's network failure (EndpointNetworkError is a TypeError): no answer.
    if (err instanceof TypeError) return { kind: "no-answer" };
    throw err;
  }
  if (!res.ok) return { kind: "answered", status: res.status, health: null };
  return {
    kind: "answered",
    status: res.status,
    health: await readEndpointResponse(getHealthEndpoint, res),
  };
}

/** Whether the page's own host answers HTTP right now (see `HostReach`). */
export function reachHost(): Promise<HostReach> {
  return reachHostOver(pageTransport.fetch);
}

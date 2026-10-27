import {
  endpointRequest,
  readEndpointResponse,
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
export async function getHealth(signal?: AbortSignal): Promise<HealthResponse | null> {
  const { path, init } = endpointRequest(getHealthEndpoint, {}, { signal });
  try {
    return await readEndpointResponse(
      getHealthEndpoint,
      await pageTransport.fetch(path, init),
    );
  // eslint-disable-next-line promise-safety/no-bare-catch, promise-safety/no-absorbed-failure -- health probe intentionally swallows all errors (network down, server not started, abort) and returns null; any propagation here would be wrong since callers use null to mean "unreachable"
  } catch {
    return null;
  }
}

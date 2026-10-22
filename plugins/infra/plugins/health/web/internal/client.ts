import { fetchEndpointOver } from "@plugins/infra/plugins/endpoints/web";
import { pageTransport } from "@plugins/primitives/plugins/networking/plugins/page-transport/web";
import type { HealthResponse } from "../../shared/protocol";
import { getHealth as getHealthEndpoint } from "../../shared/endpoints";

// Page-level health: probes the page's own server.
const fetchEndpoint = fetchEndpointOver(pageTransport);

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse | null> {
  try {
    return await fetchEndpoint(getHealthEndpoint, {}, { signal });
  // eslint-disable-next-line promise-safety/no-bare-catch, promise-safety/no-absorbed-failure -- health probe intentionally swallows all errors (network down, server not started, abort) and returns null; any propagation here would be wrong since callers use null to mean "unreachable"
  } catch {
    return null;
  }
}

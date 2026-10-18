import type { EndpointDef, MachineEndpointDef } from "../../core";

// Single source of the TanStack Query key for an endpoint read. useEndpoint
// (the subscriber) and hydrateEndpoint (the boot-time seeder) must build the
// SAME key byte-for-byte, or a seeded entry is silently invisible to the hook —
// so neither constructs it inline.
export function endpointQueryKey<
  Route extends string,
  TParams,
  TResponse,
  TQuery,
>(
  endpoint:
    | EndpointDef<Route, TParams, void, TResponse, TQuery>
    | MachineEndpointDef<Route, TParams, void, TResponse, TQuery>,
  params: TParams,
  query: TQuery | undefined,
): unknown[] {
  return [
    "endpoint",
    endpoint.route,
    JSON.stringify(params ?? {}),
    JSON.stringify(query ?? {}),
  ];
}

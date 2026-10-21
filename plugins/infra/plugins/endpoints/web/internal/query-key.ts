import type { EndpointDef, MachineEndpointDef } from "../../core";

// Single source of the TanStack Query key for an endpoint read. useEndpoint
// (the subscriber) and every reader of its cache entry must build the SAME key
// byte-for-byte, or an entry is silently invisible to the hook — so none
// constructs it inline.
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

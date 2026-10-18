import {
  useQuery,
  type UseQueryResult,
  type UseQueryOptions,
} from "@tanstack/react-query";
import {
  useTransport,
  type Transport,
} from "@plugins/primitives/plugins/networking/web";
import type {
  EndpointDef,
  MachineEndpointDef,
  MachineResult,
} from "../../core";
import { fetchEndpoint, EndpointError } from "./fetch-endpoint";
import { endpointQueryKey } from "./query-key";

/**
 * TanStack Query wrapper for GET endpoints.
 *
 * Query key: ["endpoint", route, serializedParams, serializedQuery]
 *
 * A desktop-only endpoint (`needsMachine`) reads a `MachineResult` — its value,
 * or `unavailable` (no request) under a transport with no computer behind it.
 */
export function useEndpoint<Route extends string, TParams, TResponse, TQuery>(
  endpoint: MachineEndpointDef<Route, TParams, void, TResponse, TQuery>,
  params: TParams,
  opts?: { query?: TQuery } & Omit<
    UseQueryOptions<
      MachineResult<TResponse>,
      EndpointError,
      MachineResult<TResponse>
    >,
    "queryKey" | "queryFn"
  >,
): UseQueryResult<MachineResult<TResponse>>;
export function useEndpoint<Route extends string, TParams, TResponse, TQuery>(
  endpoint: EndpointDef<Route, TParams, void, TResponse, TQuery>,
  params: TParams,
  opts?: { query?: TQuery } & Omit<
    UseQueryOptions<TResponse, EndpointError, TResponse>,
    "queryKey" | "queryFn"
  >,
): UseQueryResult<TResponse>;
export function useEndpoint<Route extends string, TParams, TResponse, TQuery>(
  endpoint:
    | EndpointDef<Route, TParams, void, TResponse, TQuery>
    | MachineEndpointDef<Route, TParams, void, TResponse, TQuery>,
  params: TParams,
  opts?: { query?: TQuery } & Omit<
    UseQueryOptions<TResponse, EndpointError, TResponse>,
    "queryKey" | "queryFn"
  >,
): UseQueryResult<TResponse> | UseQueryResult<MachineResult<TResponse>> {
  const { query, ...queryOptions } = opts ?? {};
  const transport = useTransport();

  return useQuery({
    queryKey: endpointQueryKey(endpoint, params, query),
    queryFn: async ({ signal }) => {
      const fetchOpts =
        query != null
          ? ({ query, signal, transport } as {
              query: TQuery;
              signal: AbortSignal;
              transport: Transport;
            })
          : ({ signal, transport } as {
              signal: AbortSignal;
              transport: Transport;
            });
      // A machine endpoint's answer is its `MachineResult`, kept whole.
      const result = await fetchEndpoint(
        endpoint as EndpointDef<Route, TParams, void, TResponse, TQuery>,
        params,
        // internal dispatch; external callers are fully typed
        fetchOpts as any,
      );
      return result as TResponse;
    },
    ...queryOptions,
  });
}

import {
  useQuery,
  type UseQueryResult,
  type UseQueryOptions,
} from "@tanstack/react-query";
import {
  useTransport,
  type Transport,
} from "@plugins/primitives/plugins/networking/web";
import type { EndpointDef } from "../../core";
import { fetchEndpoint, EndpointError } from "./fetch-endpoint";
import { endpointQueryKey } from "./query-key";

/**
 * TanStack Query wrapper for GET endpoints.
 *
 * Query key: ["endpoint", route, serializedParams, serializedQuery]
 */
export function useEndpoint<Route extends string, TParams, TResponse, TQuery>(
  endpoint: EndpointDef<Route, TParams, void, TResponse, TQuery>,
  params: TParams,
  opts?: { query?: TQuery } & Omit<
    UseQueryOptions<TResponse, EndpointError, TResponse>,
    "queryKey" | "queryFn"
  >,
): UseQueryResult<TResponse> {
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
      const result = await fetchEndpoint(
        endpoint,
        params,
        // internal dispatch; external callers are fully typed
        fetchOpts as any,
      );
      return result as TResponse;
    },
    ...queryOptions,
  });
}

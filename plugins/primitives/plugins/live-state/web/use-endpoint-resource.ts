import { useMemo } from "react";
import type { UseQueryOptions } from "@tanstack/react-query";
import type { EndpointDef } from "@plugins/infra/plugins/endpoints/core";
import {
  useEndpoint,
  type EndpointError,
} from "@plugins/infra/plugins/endpoints/web";
import { queryResult } from "./query-result";
import type { ResourceResult } from "./use-resource";

/**
 * A GET endpoint read as a `ResourceResult` — the endpoint companion to
 * `useResource`. `useEndpoint`
 * hands back React Query's own result, whose `data` is `undefined` both while
 * loading and after a first-load failure; a domain hook re-shaping that by hand
 * either collapses the two (a failed catalog renders as forever-loading) or has
 * to hand-write result arms. This is the one place that mapping is written:
 *
 * - `error` whenever the last fetch failed — with the value it held before as
 *   `stale`, if any (a failed refetch keeps React Query's data);
 * - `loading` while no value has landed and nothing failed;
 * - `ready` otherwise.
 *
 * The error is classified through the same `toResourceError` a live read's is,
 * so a surface renders both failures alike. The result is memoized on the
 * query's data / error identity, like `useResource`'s. The mapping is
 * `useQueryResource`'s (`queryResult`). Query options (`staleTime`, …) pass through, except
 * `enabled`: a disabled read would be `loading` forever.
 *
 * Lives here, not in endpoints: live-state owns `ResourceResult` and already
 * sits downstream of endpoints.
 */
export function useEndpointResource<
  Route extends string,
  TParams,
  TResponse,
  TQuery,
>(
  endpoint: EndpointDef<Route, TParams, void, TResponse, TQuery>,
  params: TParams,
  opts?: { query?: TQuery } & Omit<
    UseQueryOptions<TResponse, EndpointError, TResponse>,
    "queryKey" | "queryFn" | "enabled"
  >,
): ResourceResult<TResponse> {
  const q = useEndpoint(endpoint, params, opts);
  const { data, error, refetch: refetchQuery } = q;
  return useMemo(
    () => queryResult(data, error, refetchQuery),
    [data, error, refetchQuery],
  );
}

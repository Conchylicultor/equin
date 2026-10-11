import { useMemo } from "react";
import {
  useQuery,
  type QueryKey,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { queryResult } from "./query-result";
import type { ResourceResult } from "./use-resource";

/**
 * A LOCAL async load read as a `ResourceResult` — a code-split module
 * (`plugin-meta/exhibits` loads its exhibits this way), a browser API, any
 * promise that is not a read of the server. It is NOT a server read: a read of
 * server data is live — a `liveValue` (with `params`, a typed `query`, or
 * cursor-`paged`) or a `liveCollection`, read with `useLive`
 * (`network/live`) — so it refreshes itself when the data changes. There is
 * deliberately no form keyed by another read (a revision tick): that was the
 * hand-made freshness `network/live` replaced.
 *
 * React Query's own result hands `data: undefined` both while loading and
 * after a first-load failure, and its `isPending` / `isError` booleans let a
 * surface read `data ?? []` without asking which state it is in — the
 * pending-as-empty collapse. This turns it into the three arms every read
 * has, through the same mapping `useEndpointResource` uses:
 *
 * - `error` whenever the last fetch failed — the value it held before as
 *   `stale`, if any (a failed refetch keeps React Query's data);
 * - `loading` while no value has landed and nothing failed;
 * - `ready` otherwise (a `placeholderData` the caller opted into included).
 *
 * `enabled` is not an option: a disabled query is `loading` forever, the
 * spin-on-a-read-that-will-never-load bug.
 */
export type QueryResourceOptions<
  TQueryFnData,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
> = Omit<UseQueryOptions<TQueryFnData, Error, TData, TQueryKey>, "enabled">;

/**
 * What a paged read adds to its ready arm — one vocabulary for every grow-able
 * read: `useLive`'s window and its paged reads (a scroll collection's or a
 * paged value's key-range pages, every one live).
 */
export interface ResourcePaging {
  /** There is more to load — `loadMore()` would add some. */
  canGrow: boolean;
  /** A `loadMore()` is loading; what is shown is what was already held. */
  growing: boolean;
  /** Load the next page (or grow the window by one). */
  loadMore: () => void;
}

/**
 * A paged read: `ResourceResult<Item[]>` whose ready arm carries the paging
 * handles. A load-more that FAILS is the error arm, with what was already
 * held as `stale` — the items the user was looking at, never a spinner.
 */
export type PagedResourceResult<Item> =
  | Extract<ResourceResult<Item[]>, { status: "loading" }>
  | Extract<ResourceResult<Item[]>, { status: "error" }>
  | (Extract<ResourceResult<Item[]>, { status: "ready" }> & ResourcePaging);

/** A local async load (a TanStack query) as a `ResourceResult`. */
export function useQueryResource<
  TQueryFnData,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  options: QueryResourceOptions<TQueryFnData, TData, TQueryKey>,
): ResourceResult<TData> {
  const { data, error, refetch } = useQuery(options);
  return useMemo(
    (): ResourceResult<TData> => queryResult(data, error, refetch),
    [data, error, refetch],
  );
}

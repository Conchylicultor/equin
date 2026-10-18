import { useCallback, useMemo, useState } from "react";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import {
  endpointQueryKey,
  fetchEndpoint,
  getEndpointErrorMessage,
} from "@plugins/infra/plugins/endpoints/web";
import {
  hostFsList,
  type HostFsListResult,
} from "@plugins/infra/plugins/host-fs/core";

/**
 * One directory's listing as the explorer holds it. `result` is the last answer
 * the server gave (kept while a refresh is in flight, so a refresh never blanks
 * a folder); `error` is a request that failed outright (network, 500) — a
 * missing or denied folder is not an error, it is a `result` kind.
 */
export interface Listing {
  result: HostFsListResult | null;
  inFlight: boolean;
  error: string | null;
  retry: () => void;
}

/** Every listing a browser holds, by the path it was asked under. */
export type Listings = ReadonlyMap<string, Listing>;

/**
 * Whether `dir` was listed from the disk itself — not from inside an archive
 * (`within`), whose entries cannot be written to.
 */
export function isOnDisk(listings: Listings, dir: string): boolean {
  const result = listings.get(dir)?.result;
  return result?.kind === "ok" && result.within === undefined;
}

function toListing(query: UseQueryResult<HostFsListResult>): Listing {
  return {
    result: query.data ?? null,
    inFlight: query.isFetching,
    error: query.isError ? getEndpointErrorMessage(query.error) : null,
    retry: () => void query.refetch(),
  };
}

/**
 * The listings of `root` and of every folder the tree has asked to open.
 *
 * Each listing is a host-fs `list` read through the app's query cache — the
 * same key `useEndpoint(hostFsList, …)` reads — so a listing outlives the
 * browser instance that fetched it: re-rooting into a folder already expanded,
 * or coming back to one, paints at once while it is re-read (a visit always
 * re-lists, so a folder is never shown older than the moment it was opened).
 */
export function useListings(root: string): {
  listings: Listings;
  /** Ask for a folder's listing (the tree's lazy `load`). */
  request: (path: string) => void;
} {
  const [requested, setRequested] = useState<readonly string[]>([]);
  const paths = useMemo(
    () => [root, ...requested.filter((p) => p !== root)],
    [root, requested],
  );
  const request = useCallback(
    (path: string) =>
      setRequested((prev) => (prev.includes(path) ? prev : [...prev, path])),
    [],
  );
  const combine = useCallback(
    (results: UseQueryResult<HostFsListResult>[]): Listings =>
      new Map(results.map((q, i) => [paths[i]!, toListing(q)])),
    [paths],
  );
  const listings = useQueries({
    queries: paths.map((path) => ({
      queryKey: endpointQueryKey(hostFsList, {}, { path }),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchEndpoint(hostFsList, {}, { query: { path }, signal }),
    })),
    combine,
  });
  return { listings, request };
}

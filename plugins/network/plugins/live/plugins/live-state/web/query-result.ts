import { toResourceError } from "./resource-error";
import type { ResourceResult } from "./use-resource";

/**
 * THE mapping from a TanStack query's (data, error) to a `ResourceResult` —
 * shared by `useResource` (a live read's cache entry) and `useQueryResource`
 * (a local async load). Pure; memoize at the call site.
 *
 * - `error` whenever the last fetch failed — the value it held before as
 *   `stale`, if any;
 * - `loading` while no value has landed and nothing failed;
 * - `ready` otherwise.
 *
 * `landed` says whether a value has landed. It defaults to
 * `data !== undefined`; a read whose `data` is a SELECTED slice
 * (`useResource`'s `select`) passes its query's own answer
 * (`dataUpdatedAt !== 0`), because a selector may answer `undefined` for a
 * landed value — a point lookup that finds nothing is `ready`, not `loading`.
 */
export function queryResult<T>(
  data: T | undefined,
  error: unknown,
  refetchQuery: () => Promise<unknown>,
  landed: boolean = data !== undefined,
): ResourceResult<T> {
  const refetch = () => refetchQuery().then(() => {});
  const value = landed ? data : undefined;
  if (error !== null && error !== undefined)
    return value === undefined
      ? { status: "error", error: toResourceError(error), refetch }
      : {
          status: "error",
          error: toResourceError(error),
          stale: value,
          refetch,
        };
  if (!landed) return { status: "loading", refetch };
  return { status: "ready", data: data as T, refetch };
}

import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import type { LiveRowResult } from "./use-live";

/**
 * Reduce a by-id row read to a `ResourceResult` of what the row MEANS, without
 * erasing its readiness — the `mapResource` of a row read (`useLive(c, { id })`). `fn` receives the
 * row, or `null` when the read settled with no such row (an absent row is an
 * answer — "not armed", "off", "offset 0" — that only the caller can name).
 * Loading and error pass through; the error arm's last-seen `stale` row, if
 * any, is mapped the same way.
 *
 * Pure; `fn` runs on every call, so memoize its output at the call site when a
 * stable identity matters.
 */
export function mapRow<Row, U>(
  result: LiveRowResult<Row>,
  fn: (row: Row | null) => U,
): ResourceResult<U> {
  switch (result.status) {
    case "loading":
      return result;
    case "error":
      return result.stale === undefined
        ? {
            status: "error",
            error: result.error,
            refetch: result.refetch,
          }
        : {
            status: "error",
            error: result.error,
            stale: fn(result.stale),
            refetch: result.refetch,
          };
    case "ready":
      return {
        status: "ready",
        data: fn(result.found ? result.row : null),
        refetch: result.refetch,
      };
  }
}

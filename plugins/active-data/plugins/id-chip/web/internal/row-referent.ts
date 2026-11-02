import type { LiveRowResult } from "@plugins/network/plugins/live/web";
import type { IdReferentState } from "@plugins/ids/web";

/**
 * A presenter's referent from a live by-id row read (`useLive(c, { id })`): loading
 * stays loading, a failed read is `failed` (never "missing" — the referent may
 * well exist), a determinate absence is `missing`, and a found row is titled by
 * `title`. The one fold every row-backed presenter shares, so none re-derives
 * the four arms.
 */
export function rowReferent<Row>(
  result: LiveRowResult<Row>,
  title: (row: Row) => string,
): IdReferentState {
  switch (result.status) {
    case "loading":
      return { status: "loading" };
    case "error":
      return { status: "failed", error: result.error };
    case "ready":
      return result.found
        ? { status: "found", title: title(result.row) }
        : { status: "missing" };
  }
}

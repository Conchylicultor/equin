import type { LiveRowResult } from "./use-live";

/**
 * A by-id row read (`useLive(c, { id })`) reduced to the row as far as it is
 * known: the found row, else — on a failed re-read — the row as last seen
 * (`stale`), else `undefined`.
 *
 * `undefined` covers loading AND absent, so this is the one sanctioned
 * spelling of that reduction (lint `live/no-row-absence-collapse`), for a
 * surface whose rendering is the same truthful thing either way:
 *
 * - a pane body under a resolve guard (`resolveRow`), which has already
 *   painted Loading / error / Not Found — `undefined` is its loading state,
 *   never an empty one;
 * - a title with a fallback, a crumb with a label, a chip that shows nothing
 *   or the raw id.
 *
 * A surface nothing answers absence for renders each arm itself (`RowView`).
 */
export function rowOrStale<Row>(row: LiveRowResult<Row>): Row | undefined {
  switch (row.status) {
    case "loading":
      return undefined;
    case "error":
      return row.stale;
    case "ready":
      return row.found ? row.row : undefined;
  }
}

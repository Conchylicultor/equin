import { useLive } from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import { starredPages, type StarredPageRow } from "../../shared/resources";

/** The favorites: not known yet, failed, or the starred page ids. */
export type StarredPageIds = ResourceResult<ReadonlySet<string>>;

// Stable (module-level), so the `select` re-runs only when the set changes.
function toIdSet(rows: readonly StarredPageRow[]): ReadonlySet<string> {
  return new Set(rows.map((r) => r.blockId));
}

/**
 * The starred page ids: the whole favorites set.
 *
 * The ONE read of `starredPages`, shared by the `starred` field and both star
 * toggles — so the field and the toggles can never disagree about what is
 * starred, and every mount lands on the set's one `{}` tuple (one
 * subscription for the whole app, rather than one per rendered row).
 *
 * Not known yet is its own arm, never an empty set: the two callers want
 * different things from it. A toggle renders a not-known-yet state (a hollow
 * star would claim "not a favorite"), while the field deliberately projects an
 * empty set (the rationale is in `starred-field.tsx`) — each decides at its own
 * call site.
 */
export function useStarredPageIds(): StarredPageIds {
  return useLive(starredPages, { select: toIdSet });
}

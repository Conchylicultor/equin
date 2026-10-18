import {
  liveCollection,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import { bootTracesEntityRef } from "./fields";

/**
 * The saved boot traces (`boot_traces`), newest first, as the Boot Profiles
 * browse pane's live source. The row is the metadata projection — the server
 * projects exactly these keys, so the snapshot blob never rides the list. Read
 * as key-range pages (100 a page); a save (Copy permalink) or the 30-day retention
 * sweep reaches it through the change feed.
 */
export const bootTraces = liveCollection("debug.boot-traces", {
  from: bootTracesEntityRef,
  pick: ["worktree", "id", "createdAt"],
  id: "id",
  sortable: ["createdAt", "worktree"],
  default: { orderBy: [["createdAt", "desc"]], limit: 100 },
  maxLimit: 500,
});

/** One saved snapshot's metadata — the list's row, with no snapshot blob. */
export type BootTraceItem =
  typeof bootTraces extends LiveRowsCollection<infer R> ? R : never;

/**
 * One saved boot trace with its full snapshot, read by id (`useLiveRow`) for
 * the permalink detail pane: a lookup-only collection over the same table, so
 * `found: false` is "no such snapshot".
 */
export const bootTrace = liveCollection("debug.boot-trace", {
  from: bootTracesEntityRef,
  carry: { pick: ["id", "worktree", "snapshot", "createdAt"] },
  id: "id",
});

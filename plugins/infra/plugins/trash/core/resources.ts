import {
  liveCollection,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import { trashEntriesEntityRef } from "./entity";

// The trash ledger as a live collection: a bounded window, newest-deleted first
// (pages of 100, at most 500 rows to a reader with no viewport), plus its
// `:rows` / `:groups` siblings. A source's trash is the window filtered on
// `sourceId` — `useLive(trashEntries, { where: { sourceId } })`, or a DataView
// over `liveDataSource(trashEntries, { searchable: ["label"] }).scoped(…)`,
// which pages by its viewport with no depth cap. `label` is filterable so the
// list's search can match it. The ledger is bounded only by the 30-day purge,
// so the window is what keeps a reader's list bounded.
export const trashEntries = liveCollection("trash-entries", {
  from: trashEntriesEntityRef,
  pick: ["sourceId", "label", "deletedAt"],
  carry: { pick: ["id", "rootEntityId", "meta"] },
  id: "id",
  sortable: ["deletedAt"],
  default: { orderBy: [["deletedAt", "desc"]], limit: 100 },
  maxLimit: 500,
});

/** One trash entry, as the `trash-entries` collection delivers it. */
export type TrashEntryRow =
  typeof trashEntries extends LiveRowsCollection<infer R> ? R : never;

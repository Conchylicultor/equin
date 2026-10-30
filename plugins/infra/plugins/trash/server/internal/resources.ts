import { serveCollection } from "@plugins/network/plugins/live/server";
import { trashEntries } from "../../core";
import { _trashEntries } from "./tables";

// The trash ledger over `trash_entries`: its window (filterable on `sourceId`,
// newest-deleted first — the `(source_id, deleted_at)` index serves it) and its
// `:rows` / `:groups` siblings, every row field bound to its column by name
// (`meta` decodes through `parsedJson`). No hand-notify: the L4 change feed on
// `trash_entries` moves every subscribed window on every write — a record
// inside the domain's tx, a restore, a purge, the TTL sweep, out-of-process
// alike. A row is never updated, so `deletedAt` never re-sorts one.
export const trashEntriesServed = serveCollection(trashEntries, {
  from: _trashEntries,
});

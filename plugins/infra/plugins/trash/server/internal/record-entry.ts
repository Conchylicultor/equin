import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "@plugins/database/server";
import type { TrashEntry } from "../../core";
import { trashEntryIdKind, type TrashEntryId } from "../../core";
import { _trashEntries } from "./tables";

// Any drizzle executor the ledger insert can ride on: the global handle, a
// transaction, or a test fixture's throwaway-DB handle. The plain
// `NodePgDatabase` branch (doc-store's executor precedent) accepts both the
// global proxy and a fixture DB; the second branch accepts a `db.transaction`
// callback handle.
export type TrashExecutor =
  NodePgDatabase | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Insert one trash-ledger row for a soft-deleted root entity. MUST be called by
 * the domain inside the same transaction as its `deleted_at` UPDATE, so the
 * ledger and the domain flags cannot disagree (a crash between them would
 * otherwise strand rows that are flagged but unrestorable, or an entry that
 * points at nothing). Returns the new entry id so the domain can stamp it onto
 * its flagged rows (e.g. `page_blocks.trash_entry_id`).
 */
export async function recordTrashEntry(
  tx: TrashExecutor,
  args: {
    sourceId: string;
    rootEntityId: string;
    label: string;
    meta?: TrashEntry["meta"];
  },
): Promise<TrashEntryId> {
  const id = trashEntryIdKind.mint();
  await tx.insert(_trashEntries).values({
    id,
    sourceId: args.sourceId,
    rootEntityId: args.rootEntityId,
    label: args.label,
    meta: args.meta ?? {},
  });
  return id;
}

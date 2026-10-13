import { desc, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { listTrash } from "../../core/endpoints";
import { _trashEntries } from "./tables";

// All trash entries for one source, newest-deleted first — the HTTP twin of the
// `trash-entries` collection's `sourceId`-filtered window, unwindowed (the
// 30-day purge bounds it). Kept for agents and curl: the UI (the Pages Trash
// dialog) reads the live collection, never this.
export const handleListTrash = implement(listTrash, async ({ params }) => {
  // No cast on the way out: every column decodes to its own declared type
  // (`meta` through `parsedJson`), so the row IS a `TrashEntry`.
  return await db
    .select()
    .from(_trashEntries)
    .where(eq(_trashEntries.sourceId, params.sourceId))
    .orderBy(desc(_trashEntries.deletedAt));
});

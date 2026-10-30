import { db } from "@plugins/database/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { restoreTrash } from "../../core";
import { consumeTrashEntry } from "./entry-lifecycle";

// Restore a single trashed root: the source clears its domain `deleted_at`
// flags, then the ledger row is deleted (404 if already restored/purged).
export const handleRestoreTrash = implement(restoreTrash, async ({ params }) =>
  consumeTrashEntry(db, params, (source, entry) => source.restore(entry)),
);

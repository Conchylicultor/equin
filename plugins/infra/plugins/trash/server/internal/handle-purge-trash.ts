import { db } from "@plugins/database/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { purgeTrash } from "../../core";
import { consumeTrashEntry } from "./entry-lifecycle";

// "Delete permanently" — the source runs its destroy hooks and hard-deletes the
// roots (the FK cascades fire here, intended), then the ledger row is deleted
// (404 if already restored/purged).
export const handlePurgeTrash = implement(purgeTrash, async ({ params }) =>
  consumeTrashEntry(db, params, (source, entry) => source.purge([entry])),
);

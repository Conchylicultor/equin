import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { IdKinds } from "@plugins/ids/server";
import { trashEntryIdKind } from "../core";
import { listTrash, restoreTrash, purgeTrash } from "../core/endpoints";
import { handleListTrash } from "./internal/handle-list-trash";
import { handleRestoreTrash } from "./internal/handle-restore-trash";
import { handlePurgeTrash } from "./internal/handle-purge-trash";
import { trashEntriesServed } from "./internal/resources";

export { defineTrashSource, getTrashSource } from "./internal/registry";
export type { TrashSource } from "./internal/registry";
export { recordTrashEntry } from "./internal/record-entry";
export type { TrashExecutor } from "./internal/record-entry";
export { _trashEntries } from "./internal/tables";

export default {
  portable: true,
  description:
    "Generic trash primitive: the trash_entries operation ledger, a defineTrashSource registry, list/restore/purge endpoints, the trash-entries live collection (filterable by source); the 30-day purge sweep is the machine half's — so user content is soft-deleted (restorable) instead of hard-deleted, and FK cascades fire only at purge.",
  httpRoutes: {
    [listTrash.route]: handleListTrash,
    [restoreTrash.route]: handleRestoreTrash,
    [purgeTrash.route]: handlePurgeTrash,
  },
  contributions: [
    IdKinds.Kind({ kind: trashEntryIdKind }),
    ...trashEntriesServed.declare,
  ],
} satisfies ServerPluginDefinition;

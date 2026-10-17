import { index } from "drizzle-orm/pg-core";
import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import { trashEntriesEntityRef } from "../../core/entity";

// Operation ledger: one row per trashed ROOT entity (a bulk delete of two
// sub-pages = two independently-restorable entries). Domain-agnostic — the
// primitive never knows what a `source_id` names or what `root_entity_id`
// points at; `meta` is an opaque per-source payload, decoded by
// `TrashEntrySchema.meta`'s schema (`z.record` keeps every key a source put
// there). There is deliberately NO foreign key to any consumer table (mirror
// of `entity_versions`' decoupling): the domain rows carry their own
// `deleted_at` flags, and the ledger row is the handle to restore or purge
// them. The (source_id, deleted_at) index serves the per-source trash listing
// (newest first) and the TTL purge sweep.
const trashEntriesEntity = defineEntity(trashEntriesEntityRef, {
  primaryKey: "id",
  columns: {
    deletedAt: { default: defaultNow() },
    meta: { default: {} },
  },
  indexes: (t) => [
    index("trash_entries_source_deleted_idx").on(t.sourceId, t.deletedAt),
  ],
});

export const _trashEntries = trashEntriesEntity.table;

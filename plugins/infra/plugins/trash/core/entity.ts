import type { FieldsRecord } from "@plugins/fields/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { TRASH_ENTRY_CARRIED, TRASH_ENTRY_LISTED } from "./schemas";

/**
 * A trash entry's fields — the `trash_entries` table is built from them
 * (`server/internal/tables.ts`), the same record `TrashEntrySchema` reads.
 */
export const trashEntryFields = {
  ...TRASH_ENTRY_CARRIED,
  ...TRASH_ENTRY_LISTED,
} satisfies FieldsRecord;

/** The `trash_entries` entity — the trash ledger, one row per trashed root. */
export const trashEntriesEntityRef = entityRef(
  "trash_entries",
  trashEntryFields,
);

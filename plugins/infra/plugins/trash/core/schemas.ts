import { z } from "zod";
import { fieldsToZodObject } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { idKindField } from "@plugins/ids/core";
import { trashEntryIdKind } from "./id-kind";

// One soft-deleted root entity, awaiting restore or purge. Domain-agnostic: the
// primitive never knows what a `sourceId` names (e.g. "pages") or what
// `rootEntityId` points at (a page id). `label` is captured at trash time so the
// Trash UI can render the entry even after the underlying row is gone, and `meta`
// is an opaque per-source bag (JSON) the source may read back on restore/purge.
// Deliberately NO drizzle import here — `core/` is web-safe and importable from
// any runtime; the wire shape is derived from this schema alone.
// `sourceId` and `label` are the fields a trash list filters (and searches) by;
// the rest ride the row.
export const TRASH_ENTRY_LISTED = {
  sourceId: textField({ label: "Source" }),
  label: textField({ label: "Label" }),
};
export const TRASH_ENTRY_CARRIED = {
  id: idKindField(trashEntryIdKind),
  rootEntityId: textField(),
  // Listed by the pages trash (the one column it sorts by), never filtered.
  deletedAt: dateField({ label: "Deleted", filterable: false }),
  meta: jsonField({ schema: z.record(z.unknown()), default: {} }),
};
export const TrashEntrySchema = fieldsToZodObject({
  ...TRASH_ENTRY_CARRIED,
  ...TRASH_ENTRY_LISTED,
});
export type TrashEntry = z.infer<typeof TrashEntrySchema>;

/**
 * What a trashing mutation returns: either it trashed something — and hands back
 * the ledger handle needed to restore it (`sourceId` + `entryId`) — or there
 * was NOTHING to trash (the id was unknown, or already trashed), in which case
 * there is nothing to undo. User content is never hard-deleted by a user
 * action, so `trashed: false` never means "the domain deleted it for real".
 *
 * `sourceId` is part of the handle, not a constant a consumer may assume: one
 * domain can answer with different sources for different roots (the page
 * editor: `pages` for a page root, `page-blocks` for a paragraph), and the
 * restore endpoint is addressed by both.
 *
 * Deliberately a discriminated union and not `{ trashed: boolean; entryId?:
 * string }`: a nullable `entryId` is an absorbable failure — a consumer would
 * quietly skip recording an undo entry for a mutation that really did trash,
 * with no type error. Here "I trashed" and "I have a handle" are the same fact.
 */
export const TrashOutcomeSchema = z.discriminatedUnion("trashed", [
  z.object({
    trashed: z.literal(true),
    sourceId: z.string(),
    entryId: z.string(),
  }),
  z.object({ trashed: z.literal(false) }),
]);
export type TrashOutcome = z.infer<typeof TrashOutcomeSchema>;

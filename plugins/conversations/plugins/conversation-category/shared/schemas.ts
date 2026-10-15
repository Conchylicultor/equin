import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { fieldsToZodObject, type FieldsRecord } from "@plugins/fields/core";
import {
  parsedTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";

// Who set the classification. Written once: this IS the `source` column's decoder
// (see server/internal/tables.ts) and the wire schema's own member, so the stored
// set and the pushed set cannot drift apart.
export const CategorySourceSchema = z.enum(["haiku", "manual"]);

export const conversationCategoryFields = {
  // `categoryRowId(conversationId, categoryId)` — see shared/row-id.ts.
  id: textField(),
  conversationId: textField(),
  categoryId: textField(),
  // The ITEM's name (e.g. "P0"), stored verbatim so a row is readable on its own
  // and survives config edits. Renaming an item in config orphans its rows — the
  // stale label keeps rendering, which beats losing the classification.
  item: textField(),
  source: parsedTextField(CategorySourceSchema, { default: "haiku" }),
  // When the item or source last changed (derived; see server/internal/tables.ts).
  updatedAt: dateField(),
} satisfies FieldsRecord;
export const ConversationCategorySchema = fieldsToZodObject(
  conversationCategoryFields,
);
export type ConversationCategory = z.infer<typeof ConversationCategorySchema>;

// The category assignments, read by row id. A conversation holds one row per
// configured category, so the row id is the (conversation, category) pair
// folded into the `id` primary key (`categoryRowId`) — the id MUST be the table's
// single-column pk, because the `:rows` point routing intersects the pk values a
// write touched with each subscriber's id set. It is a lookup-only collection:
// no default window (nothing lists every assignment), minting
// `conversation-categories:rows` alone, read with `useLive(c, { ids })`.
//
// Subscribers name the exact rows they render: a sidebar row asks for the ONE
// avatar-category id (same per-row budget as before). A row whose category was
// deleted from config is therefore structurally invisible — no subscribed id
// set can contain it — which is why nothing sweeps orphans.
//
// NOT preloaded (a lookup-only collection cannot be): it hydrates post-mount,
// and CategoryAvatarRow renders a neutral disc for that one round-trip.
export const conversationCategories = liveCollection(
  "conversation-categories",
  { carry: { fields: conversationCategoryFields }, id: "id" },
);

import { z } from "zod";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import { liveCollection } from "@plugins/network/plugins/live/core";
import type { AvatarSpec } from "@plugins/fields/plugins/avatar/core";
import { SavedSymbolNameSchema } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { nullable } from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";

// Snapshot of the chosen preprompt avatar (a Material Symbols name + color),
// and the decoder for the `conversations_ext_preprompt.icon` column.
//
// The TYPE is the canonical `AvatarSpec` — a type-only import, so it is erased
// and this module never loads the avatar field plugin's runtime. Annotating the
// schema `ZodParser<AvatarSpec>` is what pins the two together: a shape that
// drifts from the interface stops compiling here.
const AvatarSpecSchema: ZodParser<AvatarSpec> = z.object({
  icon: SavedSymbolNameSchema.nullable(),
  color: z.string().nullable(),
});
// The wire/row field is nullable (a preprompt may have no icon). `nullable()`
// leaves the column's `.notNull()` off, and the jsonb decoder is handed the
// inner schema, which is never shown a `null`. The `default` is only the
// field's wire default — `nullable()` replaces it with `null`.
const prepromptIconField = nullable(
  jsonField({
    schema: AvatarSpecSchema,
    default: { icon: null, color: null },
  }),
);
export type PrepromptIcon = AvatarSpec | null;

// The `conversations_ext_preprompt` row, declared once: `server/internal/
// tables.ts` builds the side-table from this shape, and the wire row is its
// `schema`. `text` is stored as `prompt_text` (a DB-only name, set in
// `tables.ts`); `updatedAt` is the one timestamp put on the wire.
export const conversationPrepromptShape = defineExtensionShape({
  key: "conversationId",
  fields: {
    prepromptId: textField(),
    title: textField(),
    text: textField(),
    icon: prepromptIconField,
  },
  wireTimestamps: ["updatedAt"],
});
export const ConversationPrepromptSchema = conversationPrepromptShape.schema;
export type ConversationPreprompt = z.infer<typeof ConversationPrepromptSchema>;

// The launch-time preprompt snapshot of ONE conversation, read by its
// `conversationId`. The table holds 0 or 1 row per conversation — its primary
// key IS the conversation — so it is a lookup-only collection: no default
// window (nothing lists every conversation's snapshot), minting
// `conversation-preprompts:rows` alone. A reader takes its row with
// `useLiveRow(conversationPrepromptRows, conversationId)`, and `found: false`
// is "launched without a preprompt".
//
// Bounded by construction: only a mounted chip / sidebar row subscribes, a
// load is one primary-key seek, and the `:rows` point routing schedules a
// write for the one conversation whose row it named. The row id is the
// extension's key, whose column is the side-table's `parent_id` PK.
//
// NOT preloaded (a lookup-only collection cannot be): the chip and the sidebar
// icons stay unrendered for the one round-trip.
export const conversationPrepromptRows = liveCollection(
  "conversation-preprompts",
  { from: conversationPrepromptShape, id: "conversationId" },
);

import type { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";

// The `conversations_ext_notes` row, declared once: `server/internal/tables.ts`
// builds the side-table from this shape, and the wire row is its `schema`.
// `updatedAt` is the one timestamp put on the wire.
export const conversationNotesShape = defineExtensionShape({
  key: "conversationId",
  fields: { notes: textField() },
  wireTimestamps: ["updatedAt"],
});
export const ConversationNoteSchema = conversationNotesShape.schema;
export type ConversationNote = z.infer<typeof ConversationNoteSchema>;

// The note of ONE conversation, read by its `conversationId`. The table holds 0
// or 1 row per conversation — its primary key IS the conversation — so it is a
// lookup-only collection: no default window (nothing lists every
// conversation's note), minting `conversation-notes:rows` alone. A reader
// takes its row with `useLiveRow(conversationNoteRows, conversationId)`, and
// `found: false` is "this conversation has no note". (The server table handle
// is `conversationNotes`, hence the `Rows` name.)
//
// Bounded by construction: only a mounted conversation subscribes, a load is
// one primary-key seek, and the `:rows` point routing schedules a note
// upsert / delete for the one conversation whose row it named. The row id is
// the extension's key, whose column is the side-table's `parent_id` PK.
//
// NOT preloaded (a lookup-only collection cannot be): the notes editor keeps
// serverNote="" during that one round-trip (the pending arm) so
// useEditableField always has a valid initial value, and its consumers gate on
// `pending`.
export const conversationNoteRows = liveCollection("conversation-notes", {
  from: conversationNotesShape,
  id: "conversationId",
});

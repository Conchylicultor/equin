import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import {
  fieldsToZodObject,
  nullable,
  type FieldsRecord,
} from "@plugins/fields/core";
import {
  textField,
  enumTextField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { idKindField } from "@plugins/ids/core";
import { summaryIdKind } from "./id-kinds";

// The closed set of semantic phases a summary can be in. Single source of the
// enum: both `PhaseSchema` (the standalone validator the MCP tool reuses) and
// the `phase` column's `enumTextField` derive from it, so the DB column, the
// wire schema, and the tool input can never drift.
export const PHASE_VALUES = [
  "clarification_needed",
  "design_review",
  "implementation_review",
  "investigating",
  "executing",
  "other",
] as const;

export const PhaseSchema = z.enum(PHASE_VALUES);
export type Phase = z.infer<typeof PhaseSchema>;

// One append-only summary row — one per "Summarize" press, never updated. The
// physical table (server) and this wire schema both derive from this single
// field record, so a column/schema drift is unrepresentable. `id` is an
// app-minted text PK (no DB default); `generatedAt` defaults to now() in the DB.
export const conversationSummaryFields = {
  id: idKindField(summaryIdKind),
  conversationId: textField({ label: "Conversation" }),
  generatedAt: dateField(),
  model: textField(),
  turnCountAtGeneration: intField(),
  phase: enumTextField(PHASE_VALUES),
  phaseDetail: nullable(textField()),
  flags: nullable(textField()),
  nextAction: textField(),
  notes: nullable(textField()),
} satisfies FieldsRecord;

// Wire shape — what the resource ships and what the web reads. `generatedAt`
// crosses the wire as a Date (`z.coerce.date()` parses the serialised ISO
// string back into a Date on the client).
export const ConversationSummarySchema = fieldsToZodObject(
  conversationSummaryFields,
);
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

// Every summary ever generated, as a live collection over
// `conversation_summaries`: a bounded window (newest first, 20 / max 200) plus
// its `:rows` point sibling. A reader scopes it to ONE conversation with
// `where: { conversationId }` — the only declared filter, because it is the only
// one any reader applies (add `phase` when a reader filters by it) — so a tab
// never subscribes to the whole table, and the `(conversationId, generatedAt)`
// index serves the read.
//
// The latest summary is `useLive(conversationSummaries, { where:
// { conversationId }, limit: 1 })`: the window is ordered server-side, so its
// first row IS the latest (`useLatestConversationSummary`). NOT preloaded —
// route-scoped, it hydrates post-mount via its sub-ack.
const { conversationId: summaryConversationId, ...summaryCarried } =
  conversationSummaryFields;
export const conversationSummaries = liveCollection("conversation-summaries", {
  fields: { conversationId: summaryConversationId },
  carry: { fields: summaryCarried },
  id: "id",
  sortable: ["generatedAt"],
  default: { orderBy: [["generatedAt", "desc"]], limit: 20 },
  maxLimit: 200,
});

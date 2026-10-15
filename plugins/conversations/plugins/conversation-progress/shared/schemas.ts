import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { parsedTextField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";

export const PHASE_ORDER = [
  "research",
  "design",
  "implementation",
  "pushed",
] as const;
export type ConversationPhase = (typeof PHASE_ORDER)[number];

// Each label names a milestone already reached, in the past tense: a phase is
// only classified once its evidence exists (a plan file, a code change, a
// push). The first names the one milestone before any of them — the agent is
// on it. The ids stay the stored `phase` values.
export const PHASE_LABELS: Record<ConversationPhase, string> = {
  research: "Started",
  design: "Designed",
  implementation: "Implemented",
  pushed: "Pushed",
};

// One line per phase, for someone seeing the progress bar for the first time —
// each restates the rule the heuristic job classifies by.
export const PHASE_DESCRIPTIONS: Record<ConversationPhase, string> = {
  research: "Reading and exploring — no files changed yet.",
  design: "A plan is written — only files under research/ changed.",
  implementation: "Code changed in its worktree.",
  pushed: "Its work is merged into main.",
};

/** The steps of the progress bar, in order, with their tooltip copy. */
export const PHASE_STEPS = PHASE_ORDER.map((p) => ({
  id: p,
  label: PHASE_LABELS[p],
  description: PHASE_DESCRIPTIONS[p],
}));

/** What the progress bar tracks — the steps tooltip's subtitle. */
export const PROGRESS_SUMMARY = "How far this agent has got with its task";

// The two enums the progress row is made of, each written once: these ARE the
// decoders of the `phase` / `source` columns (the fields of the shape below,
// which server/internal/tables.ts builds the table from) and the wire schema's
// own members, so the stored set and the pushed set cannot drift apart.
export const ProgressPhaseSchema = z.enum(PHASE_ORDER);
// How the phase was decided: inferred from the transcript, or observed from a push.
export const ProgressSourceSchema = z.enum(["heuristic", "push"]);

// The `conversations_ext_progress` row, declared once: the table and the wire
// row both come from this shape. The `default`s are wire defaults only — the
// columns have no DB default, and every write sets both. `updatedAt` is the one
// timestamp put on the wire.
export const conversationProgressShape = defineExtensionShape({
  key: "conversationId",
  fields: {
    phase: parsedTextField(ProgressPhaseSchema, { default: "research" }),
    source: parsedTextField(ProgressSourceSchema, { default: "heuristic" }),
  },
  wireTimestamps: ["updatedAt"],
});
export const ConversationProgressSchema = conversationProgressShape.schema;
export type ConversationProgress = z.infer<typeof ConversationProgressSchema>;

// The progress row of ONE conversation, read by its `conversationId`. The table
// holds 0 or 1 row per conversation — its primary key IS the conversation — so
// it is a lookup-only collection: no default window (nothing lists every
// conversation's phase), minting `conversation-progress:rows` alone. A reader
// takes its row with `useLiveRow(conversationProgressRows, conversationId)`,
// and `found: false` is "no phase classified yet". (The server table handle is
// `conversationProgress`, hence the `Rows` name.)
//
// Bounded by construction: only a mounted progress bar subscribes, a load is
// one primary-key seek, and the `:rows` point routing schedules a phase change
// for the one conversation whose row it named — never a sweep of the table.
// The row id is the extension's key, whose column is the side-table's
// `parent_id` PK.
//
// NOT preloaded (a lookup-only collection cannot be): the progress bar renders
// nothing for the one round-trip.
export const conversationProgressRows = liveCollection(
  "conversation-progress",
  { from: conversationProgressShape, id: "conversationId" },
);

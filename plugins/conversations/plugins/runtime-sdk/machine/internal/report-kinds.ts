import { z } from "zod";
import { ReportKind, type ReportRow } from "@plugins/reports/server";

// The consumer's two hang findings. Both exist because of the 2026-10-25
// incident (conv-1792928993-rqsi2p): main's consumer stopped applying one
// conversation's events for its whole lifetime — the cursor stayed at 0 while
// the agent wrote 870+ lines — and nothing said so. One report catches the
// stall where the launch learns it (the agent answers, the projection does not
// follow); the other names the step a catch-up run is parked in.

const INCIDENT_DOC =
  "research/2026-10-25-conversations-turn-identity-and-fresh-projection.md";

function occurrences(row: ReportRow): string[] {
  return [
    `**Occurrences:** ${row.count}`,
    `**Worktree:** ${row.worktree}`,
    `**First seen:** ${row.firstSeenAt.toISOString()}`,
    `**Last seen:** ${row.lastSeenAt.toISOString()}`,
  ];
}

const ConsumerStalledSchema = z.object({
  conversationId: z.string(),
  /** The last event seq the conversation's row has applied. */
  cursorSeq: z.number().int(),
  /** The last event seq the agent says it wrote (`hello.seq`). */
  agentSeq: z.number().int(),
});
type ConsumerStalled = z.infer<typeof ConsumerStalledSchema>;

/**
 * `sdk-consumer-stalled`: **an agent is up, but this backend has not applied
 * its events** — at the end of the launch's wait, the agent answered `hello`
 * with a seq past the conversation row's cursor, so its `started` line was on
 * disk and never reached the row. The launch carries on (the agent took the
 * prompt); the conversation's status, turns and questions lag until the
 * consumer catches up.
 */
export const sdkConsumerStalledKind = ReportKind({
  kind: "sdk-consumer-stalled",
  schema: ConsumerStalledSchema,
  fingerprint: (d: ConsumerStalled) =>
    `sdk-consumer-stalled:${d.conversationId}`,
  meta: {
    tag: "[sdk-consumer]",
    notif: "An agent's events are not being applied",
    variant: "error",
  },
  renderTask: (row: ReportRow) => {
    const d = ConsumerStalledSchema.parse(row.data);
    return {
      title: `[sdk-consumer] Events of a running agent are not applied: ${d.conversationId}`,
      description: [
        `Conversation \`${d.conversationId}\`'s agent answered \`hello\` at seq ` +
          `**${d.agentSeq}**, but its \`conversations_ext_sdk_agent\` row has ` +
          `applied only up to seq **${d.cursorSeq}** — the launch waited the ` +
          "whole start bound for its `started` line to be applied, and it never was.",
        "",
        "Until the consumer catches up, the conversation's status, its turns " +
          '(an echo left on "Waiting for the agent to take it…") and its ' +
          "questions are stale. A restart of the backend replays the cursor.",
        "",
        "**What to look at:** an `sdk-catch-up-overdue` report for the same " +
          "conversation names the step its catch-up is parked in. With none, " +
          "the catch-up is not running at all: look at the events watcher " +
          "(`runtime-sdk.events`) and whether the conversation is treated as " +
          `this backend's. Background: \`${INCIDENT_DOC}\`.`,
        "",
        ...occurrences(row),
      ].join("\n"),
    };
  },
});

const CatchUpOverdueSchema = z.object({
  conversationId: z.string(),
  /** The step the run was in when the deadline passed (`read-row`, `effect:<kind>`, …). */
  stage: z.string(),
  elapsedMs: z.number(),
});
type CatchUpOverdue = z.infer<typeof CatchUpOverdueSchema>;

/**
 * `sdk-catch-up-overdue`: **a catch-up of one agent's events is still running
 * past its deadline.** Catch-ups run one at a time per conversation (a keyed
 * coalescer), so every later event of that conversation waits behind it. Filed
 * once per stuck run; nothing cancels it.
 */
export const sdkCatchUpOverdueKind = ReportKind({
  kind: "sdk-catch-up-overdue",
  schema: CatchUpOverdueSchema,
  // By step: the same wedge in another conversation is the same bug.
  fingerprint: (d: CatchUpOverdue) => `sdk-catch-up-overdue:${d.stage}`,
  // A hang detector, like span-stuck: duress is when the funnel sheds, and a
  // hang and duress are often one event. Safe on volume — one per stuck run.
  duressExempt: true,
  meta: {
    tag: "[sdk-catch-up]",
    notif: "Applying an agent's events is stuck",
    variant: "error",
  },
  renderTask: (row: ReportRow) => {
    const d = CatchUpOverdueSchema.parse(row.data);
    return {
      title: `[sdk-catch-up] Catch-up stuck at "${d.stage}": ${d.conversationId}`,
      description: [
        `A catch-up of conversation \`${d.conversationId}\`'s \`events.jsonl\` ` +
          `had been running for **${Math.round(d.elapsedMs / 1000)} s** and was ` +
          `parked in step \`${d.stage}\` (\`runtime-sdk/machine/internal/consumer.ts\`).`,
        "",
        "Catch-ups run one at a time per conversation, so every later event of " +
          "this conversation is queued behind this run: its status, turns and " +
          "questions stop moving. Nothing cancels it — an effect cannot be " +
          "aborted halfway — so it stays stuck until it settles or the backend " +
          "restarts.",
        "",
        "**What to do:** find what the named step awaits and why it never " +
          "settles (a DB call has its own deadline, so look for an unbounded " +
          "promise, a lock or a socket call), then bound it so it fails loudly. " +
          `Background: \`${INCIDENT_DOC}\`.`,
        "",
        ...occurrences(row),
      ].join("\n"),
    };
  },
});

const MAX_TEXT = 2_000;
const clip = (text: string) =>
  text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;

const TurnWithoutIdSchema = z.object({
  conversationId: z.string(),
  /** The `turn_started` line's seq in the agent's events.jsonl. */
  seq: z.number().int(),
  promptUuid: z.string(),
  text: z.string(),
});
type TurnWithoutId = z.infer<typeof TurnWithoutIdSchema>;

/**
 * `turn-without-id`: **an agent took a turn that carries no ledger id**, from
 * an agent that puts the backend's id on every turn it is sent (its `started`
 * said `turnIds`). The backend never sends a turn without one, so this turn
 * is not one the app sent; the ledger confirms nothing for it.
 */
export const turnWithoutIdKind = ReportKind({
  kind: "turn-without-id",
  schema: TurnWithoutIdSchema,
  fingerprint: (d: TurnWithoutId) => `turn-without-id:${d.conversationId}`,
  meta: {
    tag: "[turn-without-id]",
    notif: "An agent took a turn the app did not send",
    variant: "warning",
  },
  renderTask: (row: ReportRow) => {
    const d = TurnWithoutIdSchema.parse(row.data);
    return {
      title: `[turn-without-id] An agent took a turn with no turn id: ${d.conversationId}`,
      description: [
        `Conversation \`${d.conversationId}\`'s agent reported taking a turn ` +
          `(event seq **${d.seq}**, transcript line \`${d.promptUuid}\`) with ` +
          "no `turnId`, though the agent puts the backend's turn id on every " +
          "turn it is sent — so no ledger row was confirmed for it. Find what " +
          "queued a turn without one (`pushInput` in " +
          "`runtime-sdk/bin/agent.ts`, a `turn` command sent with `turnId: null`).",
        "",
        "**Text:**",
        "```",
        clip(d.text),
        "```",
        "",
        ...occurrences(row),
      ].join("\n"),
    };
  },
});

const TurnUnknownIdSchema = z.object({
  conversationId: z.string(),
  turnId: z.string(),
  promptUuid: z.string(),
  /** The conversation that owns the row, when it is another one; null when no row has the id. */
  owner: z.string().nullable(),
});
type TurnUnknownId = z.infer<typeof TurnUnknownIdSchema>;

/**
 * `turn-unknown-id`: **an agent confirmed a turn id its conversation's ledger
 * does not hold** — no row has it, or the row is another conversation's. The
 * ledger confirms nothing rather than guess; the turn's echo stays until it
 * is resolved some other way.
 */
export const turnUnknownIdKind = ReportKind({
  kind: "turn-unknown-id",
  schema: TurnUnknownIdSchema,
  fingerprint: (d: TurnUnknownId) => `turn-unknown-id:${d.conversationId}`,
  meta: {
    tag: "[turn-unknown-id]",
    notif: "An agent confirmed a turn its conversation never sent",
    variant: "error",
  },
  renderTask: (row: ReportRow) => {
    const d = TurnUnknownIdSchema.parse(row.data);
    return {
      title: `[turn-unknown-id] An agent confirmed an unknown turn: ${d.conversationId}`,
      description: [
        `Conversation \`${d.conversationId}\`'s agent reported taking turn ` +
          `\`${d.turnId}\` (transcript line \`${d.promptUuid}\`), and ` +
          (d.owner === null
            ? "no `conversation_turns` row has that id."
            : `that row belongs to conversation \`${d.owner}\`.`) +
          " Every turn is sent with its own ledger row's id " +
          "(`conversations/server/internal/turns.ts`), so find where this " +
          "one came from — a launch options file carried to another " +
          "conversation, or a row deleted under a live agent.",
        "",
        ...occurrences(row),
      ].join("\n"),
    };
  },
});

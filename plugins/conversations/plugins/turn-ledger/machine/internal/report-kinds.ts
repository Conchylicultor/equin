import { z } from "zod";
import {
  recordReport,
  ReportKind,
  type ReportRow,
} from "@plugins/reports/server";
import {
  turnVerdictSink,
  type TurnVerdict,
} from "../../server/internal/verdict-sink";

// The ledger's three findings, each filed where the fact is learned: the hook
// mailbox learns a merge, the submit check learns an unverified send, the send
// path (or Stop) learns an input box that would not empty. They replace the
// browser's `turn-unconfirmed`, which guessed from a transcript and a deadline;
// every one of these is a fact the CLI or the pane reported.

const MAX_TEXT = 2_000;
const clip = (text: string) =>
  text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;

function occurrences(row: ReportRow): string[] {
  return [
    `**Occurrences:** ${row.count}`,
    `**First seen:** ${row.firstSeenAt.toISOString()}`,
    `**Last seen:** ${row.lastSeenAt.toISOString()}`,
  ];
}

const TurnMergedSchema = z.object({
  conversationId: z.string(),
  turnId: z.string(),
  typedText: z.string(),
  extraText: z.string(),
});

/**
 * `turn-merged`: **the CLI submitted a turn together with other text** — the
 * input box still held a draft when the turn was typed, and the two went in as
 * one prompt. The sender clears the box and verifies it empty before typing, so
 * each row is a draft that got past that check.
 */
export const turnMergedKind = ReportKind({
  kind: "turn-merged",
  schema: TurnMergedSchema,
  fingerprint: (d: z.infer<typeof TurnMergedSchema>) =>
    `turn-merged:${d.conversationId}`,
  meta: {
    tag: "[turn-merged]",
    notif: "A message reached the agent merged with other text",
    variant: "warning",
  },
  renderTask: (row: ReportRow) => {
    const d = TurnMergedSchema.parse(row.data);
    return {
      title: `[turn-merged] A turn was submitted with leftover text: ${d.conversationId}`,
      description: [
        `In conversation \`${d.conversationId}\`, the agent reported turn ` +
          `\`${d.turnId}\` inside a longer prompt: other text was submitted with it. ` +
          "Each turn is sent to the agent on its own, so find where the extra text " +
          "came from.",
        "",
        "**Typed:**",
        "```",
        clip(d.typedText),
        "```",
        "**Submitted with it:**",
        "```",
        clip(d.extraText),
        "```",
        "",
        ...occurrences(row),
      ].join("\n"),
    };
  },
});

async function reportTurnMerged(row: TurnVerdict): Promise<void> {
  await recordReport({
    kind: "turn-merged",
    source: "server-caught",
    message: `${row.conversationId}: turn ${row.id} was submitted together with other text`,
    data: {
      conversationId: row.conversationId,
      turnId: row.id,
      typedText: clip(row.typedText),
      extraText: clip(row.extraText ?? ""),
    },
  });
}

const TurnUnverifiedSchema = z.object({
  conversationId: z.string(),
  turnId: z.string(),
  reason: z.string(),
});

/**
 * `turn-unverified`: **a turn was typed but the input box never confirmed the
 * submit** — the text did not surface, or the box kept it after repeated
 * Enter. The user sees Retry; a late hook still resolves the row.
 */
export const turnUnverifiedKind = ReportKind({
  kind: "turn-unverified",
  schema: TurnUnverifiedSchema,
  fingerprint: (d: z.infer<typeof TurnUnverifiedSchema>) =>
    `turn-unverified:${d.conversationId}`,
  meta: {
    tag: "[turn-unverified]",
    notif: "A message could not be verified as submitted",
    variant: "warning",
  },
  renderTask: (row: ReportRow) => {
    const d = TurnUnverifiedSchema.parse(row.data);
    return {
      title: `[turn-unverified] A typed turn was never seen submitted: ${d.conversationId}`,
      description: [
        `In conversation \`${d.conversationId}\`, turn \`${d.turnId}\` was typed into ` +
          "the agent's input box, but the submit check never saw the box empty after " +
          `Enter: ${d.reason}`,
        "",
        "Look at the agent's log (`agent.log`, beside its `events.jsonl` in the " +
          "`state/sdk-agents/<namespace>/<conversationId>/` data dir): an agent " +
          "process that is wedged or slow to answer over its socket reads this way. " +
          "If the agent did take the turn, the transcript reaching it will still " +
          "resolve the row.",
        "",
        ...occurrences(row),
      ].join("\n"),
    };
  },
});

async function reportTurnUnverified(row: TurnVerdict): Promise<void> {
  await recordReport({
    kind: "turn-unverified",
    source: "server-caught",
    message: `${row.conversationId}: turn ${row.id} was typed but its submit was never seen`,
    data: {
      conversationId: row.conversationId,
      turnId: row.id,
      reason: row.error ?? "unknown",
    },
  });
}

/**
 * File every verdict the ledger announces on `turnVerdictSink` (it holds what
 * was emitted before this registers, then replays it).
 */
export function registerTurnVerdictReports(): void {
  turnVerdictSink.register((verdict) => {
    void (verdict.verdict === "merged"
      ? reportTurnMerged(verdict)
      : reportTurnUnverified(verdict));
  });
}

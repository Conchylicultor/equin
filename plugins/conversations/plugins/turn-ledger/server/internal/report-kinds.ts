import { z } from "zod";
import {
  recordReport,
  ReportKind,
  type ReportRow,
} from "@plugins/reports/server";

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
        `In conversation \`${d.conversationId}\`, the CLI's UserPromptSubmit hook ` +
          `reported turn \`${d.turnId}\` inside a longer prompt: the input box held ` +
          "other text when it was typed. The send path clears the box and polls it " +
          "empty before typing (runtime-tmux `clearInput`), so find how this text got " +
          "past it — a draft restored after the check, or a render the parser reads as empty.",
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

export async function reportTurnMerged(row: {
  id: string;
  conversationId: string;
  typedText: string;
  extraText: string | null;
}): Promise<void> {
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
        "Look at the tmux pane: an unrecognized CLI render (`parseInputDraft` " +
          "returning null) or a host under load both read this way. If the CLI did " +
          "take the turn, its UserPromptSubmit hook will still resolve the row.",
        "",
        ...occurrences(row),
      ].join("\n"),
    };
  },
});

export async function reportTurnUnverified(row: {
  id: string;
  conversationId: string;
  error: string | null;
}): Promise<void> {
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

const InputNotEmptySchema = z.object({
  conversationId: z.string(),
  turnId: z.string().nullable(),
  during: z.enum(["send", "answer", "stop"]),
  draft: z.string(),
});

/**
 * `turn-input-not-empty`: **the agent's input box would not empty** — C-c was
 * sent on a draft and the box still held text after the bound, so the turn was
 * refused rather than typed after it (which would have submitted both as one).
 */
export const turnInputNotEmptyKind = ReportKind({
  kind: "turn-input-not-empty",
  schema: InputNotEmptySchema,
  fingerprint: (d: z.infer<typeof InputNotEmptySchema>) =>
    `turn-input-not-empty:${d.conversationId}`,
  meta: {
    tag: "[turn-input-not-empty]",
    notif: "An agent's input box could not be cleared",
    variant: "warning",
  },
  renderTask: (row: ReportRow) => {
    const d = InputNotEmptySchema.parse(row.data);
    return {
      title: `[turn-input-not-empty] An agent's input box would not clear: ${d.conversationId}`,
      description: [
        `In conversation \`${d.conversationId}\` (${d.during}` +
          `${d.turnId ? `, turn \`${d.turnId}\`` : ""}), C-c was sent on a draft ` +
          "in the input box and the box still held text when the bound ran out:",
        "",
        "```",
        clip(d.draft),
        "```",
        "",
        "The turn was refused rather than typed after it. Look at the tmux pane: " +
          "a draft the CLI keeps restoring, or a render `parseInputDraft` misreads.",
        "",
        ...occurrences(row),
      ].join("\n"),
    };
  },
});

export async function reportInputNotEmpty(input: {
  conversationId: string;
  turnId: string | null;
  during: "send" | "answer" | "stop";
  draft: string;
}): Promise<void> {
  await recordReport({
    kind: "turn-input-not-empty",
    source: "server-caught",
    message: `${input.conversationId}: the input box would not clear (${input.during})`,
    data: { ...input, draft: clip(input.draft) },
  });
}

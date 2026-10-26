import { z } from "zod";
import { ReportKind, type ReportRow } from "@plugins/reports/server";

// RETIRED. Nothing files `turn-unverified` any more: it was the retired tmux
// runtime's verdict on a typed turn (the input box never seen empty), and the
// sdk runtime has no such verdict — the agent confirms each turn by its id
// (research/2026-10-25-conversations-turn-identity-and-fresh-projection.md, A3).
// The kind stays registered so existing rows still validate, render and can be
// investigated — an investigated report keeps its row past the 7-day sweep
// (the `reports/turn-unconfirmed` precedent). Delete it once no such row is
// left: `SELECT 1 FROM reports WHERE kind = 'turn-unverified'` on main.

const TurnUnverifiedSchema = z.object({
  conversationId: z.string(),
  turnId: z.string(),
  reason: z.string(),
});

/**
 * `turn-unverified` (retired): **a turn was typed but the input box never
 * confirmed the submit**.
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
        "This kind is retired: the runtime that filed it no longer exists, so a " +
          "row is history. Nothing to fix unless the conversation still shows it.",
        "",
        `**Occurrences:** ${row.count}`,
        `**First seen:** ${row.firstSeenAt.toISOString()}`,
        `**Last seen:** ${row.lastSeenAt.toISOString()}`,
      ].join("\n"),
    };
  },
});

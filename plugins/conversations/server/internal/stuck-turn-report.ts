import { z } from "zod";
import { ReportKind, type ReportRow } from "@plugins/reports/server";

const StuckTurnSchema = z.object({
  conversationId: z.string(),
  /** Since when its agent has rested holding the unstarted turn (ISO). */
  since: z.string(),
});

export type StuckTurnData = z.infer<typeof StuckTurnSchema>;

/**
 * The `conversation-stuck-turn` report kind: **an agent alive and at rest
 * holds a turn it was handed and does not start it** — the status reconciler
 * made the conversation stuck (`waitingFor` `stuck-turn`, plan-update's
 * `STUCK_TURN_MS`). Filed once per entry into stuck; one row per
 * conversation, its count the times it got stuck.
 */
export const conversationStuckTurnKind = ReportKind({
  kind: "conversation-stuck-turn",
  schema: StuckTurnSchema,
  fingerprint: (d: StuckTurnData) =>
    `conversation-stuck-turn:${d.conversationId}`,
  meta: {
    tag: "[stuck-turn]",
    notif: "An agent holds a turn it never started",
    variant: "warning",
  },
  renderTask: (row: ReportRow) => {
    const d = StuckTurnSchema.parse(row.data);
    return {
      title: `[stuck-turn] Agent never started a turn it was handed: ${d.conversationId}`,
      description: [
        `Conversation \`${d.conversationId}\`'s agent is alive and at rest (its ` +
          "projection says no turn runs and no background work is pending), " +
          "yet it has held a turn-ledger row in `typing` / `typed` since " +
          `${d.since} without starting it. An idle Claude Code starts a ` +
          "queued turn at once, so the status reconciler reads it as stuck " +
          "(`waiting`, `waitingFor: stuck-turn`) rather than working.",
        "",
        "Find out why the turn never started: the agent's log (`agent.log`, " +
          "beside its `events.jsonl` in `state/sdk-agents/<namespace>/<conversationId>/`) " +
          "— did the agent hand the message to the CLI, did the CLI report a " +
          "`command_lifecycle` for it, is the CLI process itself alive " +
          "(a native `sample` of it shows where it is parked)? A `typing` row " +
          "means the backend's send never finished.",
        "",
        `**Occurrences:** ${row.count}`,
        `**First seen:** ${row.firstSeenAt.toISOString()}`,
        `**Last seen:** ${row.lastSeenAt.toISOString()}`,
      ].join("\n"),
    };
  },
});

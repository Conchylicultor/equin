import { z } from "zod";
import { ReportKind, type ReportRow } from "@plugins/reports/server";

// The spawn job's two failure reports. Both used to be bare bell notifications
// with nowhere to click: the failure reached the user as text and nothing else —
// no report, no Investigate. A report gives it a detail pane, dedup, and the
// on-demand investigation task.

const MESSAGE_MAX = 4_000;

const SpawnFailedPayloadSchema = z.object({
  conversationId: z.string(),
  attemptId: z.string(),
  worktreePath: z.string(),
  runtimeId: z.string(),
  // Which of the job's two steps threw: the `git worktree add` checkout, or the
  // runtime session start. They fail for different reasons and are fixed in
  // different places, so the investigation should not have to guess.
  step: z.enum(["worktree", "runtime"]),
  // Whether the job's own deadline signal had fired when it threw. A git child
  // killed by SIGTERM (exit 143) mid-checkout is usually this: the dispatch
  // overran its hold class and the signal killed the checkout.
  deadlineAborted: z.boolean(),
  errorType: z.string(),
  error: z.string(),
});
type SpawnFailedPayload = z.infer<typeof SpawnFailedPayloadSchema>;

/**
 * The `conversation-spawn-failed` report kind: **a launched conversation's
 * session could not be started** — its worktree checkout or its runtime session
 * threw. The job retries (graphile), so one row per conversation collects every
 * attempt as its count; the row stays `starting` until the status sweep moves
 * it to `gone`.
 */
export const conversationSpawnFailedKind = ReportKind({
  kind: "conversation-spawn-failed",
  schema: SpawnFailedPayloadSchema,
  fingerprint: (d: SpawnFailedPayload) =>
    `conversation-spawn-failed:${d.conversationId}`,
  meta: {
    tag: "[spawn]",
    notif: "Conversation spawn failed",
    variant: "error",
    category: "error",
  },
  renderTask: (row: ReportRow) => {
    const d = SpawnFailedPayloadSchema.parse(row.data);
    return {
      title: `[spawn] Conversation spawn failed at ${d.step === "worktree" ? "worktree checkout" : "session start"}: ${d.conversationId}`,
      description: renderSpawnFailed(row, d),
    };
  },
});

function renderSpawnFailed(row: ReportRow, d: SpawnFailedPayload): string {
  const lines: string[] = [];
  lines.push(
    d.step === "worktree"
      ? `The \`conversations.spawn\` job could not create the worktree checkout ` +
          `for conversation \`${d.conversationId}\` (\`git worktree add\` via ` +
          `\`setupWorktree\`).`
      : `The \`conversations.spawn\` job created the checkout but could not ` +
          `start the runtime session for conversation \`${d.conversationId}\`.`,
  );
  lines.push("");
  lines.push(
    "The job retries up to its max attempts; each failure bumps this report's " +
      "count. On exhaustion the job's `onDead` has the status reconciler move " +
      "the conversation to `gone` at once, showing this failure; Resume can " +
      "retry it from there.",
  );
  lines.push("");
  if (d.deadlineAborted) {
    lines.push(
      "**The job's deadline signal had fired when this threw**, so the step was " +
        "most likely killed for overrunning its hold class rather than failing " +
        "on its own. Look at why it was slow (host contention, the " +
        "`worktree-mutate` gate) before reading the error text.",
    );
    lines.push("");
  }
  lines.push(`**Error** (\`${d.errorType}\`):`);
  lines.push("");
  lines.push("```");
  lines.push(clamp(d.error));
  lines.push("```");
  lines.push("");
  lines.push(`**Conversation:** \`${d.conversationId}\``);
  lines.push(`**Attempt:** \`${d.attemptId}\``);
  lines.push(`**Worktree:** \`${d.worktreePath}\``);
  lines.push(`**Runtime:** \`${d.runtimeId}\``);
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}

const ClaudeCodeUnavailablePayloadSchema = z.object({
  conversationId: z.string(),
  error: z.string(),
});
type ClaudeCodeUnavailablePayload = z.infer<
  typeof ClaudeCodeUnavailablePayloadSchema
>;

/**
 * The `claude-code-unavailable-at-spawn` report kind: **Claude Code went
 * missing (or signed out) between a launch's check and its spawn.** One rolling
 * row — it is one machine condition, not a per-conversation problem — whose
 * count says how many spawns it cost. The job does not retry it.
 */
export const claudeCodeUnavailableAtSpawnKind = ReportKind({
  kind: "claude-code-unavailable-at-spawn",
  schema: ClaudeCodeUnavailablePayloadSchema,
  fingerprint: () => "claude-code-unavailable-at-spawn",
  meta: {
    tag: "[spawn]",
    notif: "Claude Code is not available",
    variant: "error",
    category: "error",
  },
  renderTask: (row: ReportRow) => {
    const d = ClaudeCodeUnavailablePayloadSchema.parse(row.data);
    return {
      title: "[spawn] Claude Code unavailable when a conversation spawned",
      description: renderClaudeCodeUnavailable(row, d),
    };
  },
});

function renderClaudeCodeUnavailable(
  row: ReportRow,
  d: ClaudeCodeUnavailablePayload,
): string {
  return [
    "A conversation's spawn found the Claude Code CLI missing or signed out, " +
      "after its launch had already checked it. The spawn was not retried; " +
      "the conversation moves to `gone`, and Resume works once Claude Code is back.",
    "",
    "**Error:**",
    "",
    "```",
    clamp(d.error),
    "```",
    "",
    "The health report's Claude Code row shows the current state and the " +
      "install / sign-in commands.",
    "",
    `**Latest conversation:** \`${d.conversationId}\``,
    `**Occurrences:** ${row.count}`,
    `**First seen:** ${row.firstSeenAt.toISOString()}`,
    `**Last seen:** ${row.lastSeenAt.toISOString()}`,
  ].join("\n");
}

function clamp(value: string): string {
  return value.length <= MESSAGE_MAX
    ? value
    : `${value.slice(0, MESSAGE_MAX)}\n… [truncated ${value.length - MESSAGE_MAX} chars]`;
}

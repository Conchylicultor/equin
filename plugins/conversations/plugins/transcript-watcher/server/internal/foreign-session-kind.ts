import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import {
  ForeignSessionPayloadSchema,
  type ForeignSessionPayload,
} from "../../core";

// Re-alert the bell at most once per ~6h while a foreign entry stays in a chain.
// It is a standing data-loss condition — `rewindLastUserTurn` targets the chain
// tail, so a foreign tail makes the Stop button truncate a stranger's live
// transcript — so it should resurface periodically without spamming. Matches the
// session-divergence 6h re-arm.
const FOREIGN_SESSION_NOTIF_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * The `conversation-foreign-session` report kind: a session id in one
 * conversation's chain that belongs to another conversation.
 *
 * Deduped per `(conversationId, foreignSessionId)` — the unit of repair is one
 * `conversation_sessions` row — so a chain that stays corrupted collapses to a
 * single task whose `count` is how many reads (or monitor ticks) saw it.
 *
 * Variant `warning`: nothing crashes. The read path already refuses to merge the
 * foreign transcript, so the user sees a correct conversation; what is still
 * wrong is the stored row, and it stays wrong until somebody deletes it.
 */
export const foreignSessionKind = ReportKind({
  kind: "conversation-foreign-session",
  schema: ForeignSessionPayloadSchema,
  fingerprint: (d: ForeignSessionPayload) =>
    `foreign-session:${d.conversationId}:${d.foreignSessionId}`,
  meta: {
    tag: "[session]",
    notif: "Foreign session id in a conversation's chain",
    variant: "warning",
    notifCooldownMs: FOREIGN_SESSION_NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = ForeignSessionPayloadSchema.parse(row.data);
    return {
      title: `[session] Foreign session in ${d.conversationId}: ${d.foreignSessionId.slice(0, 8)}`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(row: ReportRow, d: ForeignSessionPayload): string {
  const lines: string[] = [];
  lines.push(
    `Conversation \`${d.conversationId}\` has \`${d.foreignSessionId}\` in its ` +
      `recorded session chain (\`conversation_sessions\`), but that session ` +
      `belongs to a **different conversation**.`,
  );
  lines.push("");

  if (d.reason === "directory-mismatch") {
    lines.push(
      `**How it was seen:** the read path resolved the id to a transcript in ` +
        `\`${d.foreignDir}\`, while this conversation's own sessions live in ` +
        `\`${d.anchorDir}\`. All of a conversation's sessions run in one ` +
        `worktree (a fork must inherit its source's attempt), so two projects ` +
        `directories in one chain can only mean mis-attribution.`,
    );
  } else {
    lines.push(
      `**How it was seen:** the same \`claude_session_id\` appears in the chain ` +
        `of ${d.otherConversationIds.length} other conversation(s): ` +
        `${d.otherConversationIds.map((id) => `\`${id}\``).join(", ")}. ` +
        `A Claude session belongs to exactly one conversation.`,
    );
  }

  lines.push("");
  lines.push(
    `**Why it matters.** The read path drops the foreign file, so the ` +
      `transcript renders correctly. The stored row does not self-heal: writes ` +
      `target the chain tail, so while a foreign id is the tail, ` +
      `\`rewindLastUserTurn\` (the Stop button) truncates another agent's live ` +
      `transcript, and \`claude --resume\` on the stored ` +
      `\`conversations.claude_session_id\` attaches to that agent's session.`,
  );
  lines.push("");
  lines.push(`**Triage**`);
  lines.push(
    `1. Confirm both sides: ` +
      `\`select conversation_id, claude_session_id, seen_at from ` +
      `conversation_sessions where claude_session_id = ` +
      `'${d.foreignSessionId}' order by seen_at\`.`,
  );
  lines.push(
    `2. Decide which conversation genuinely ran the session (its transcript's ` +
      `directory names the worktree).`,
  );
  lines.push(
    `3. Repair through a guarded DML data migration scoped to the wrong ` +
      `conversation alone — delete its \`conversation_sessions\` row and, if ` +
      `\`conversations.claude_session_id\` still holds the foreign value, patch ` +
      `it back to the real tail. \`conversation_sessions\` is append-only for ` +
      `the application; a migration is the sanctioned repair path. See ` +
      `\`research/2026-08-19-global-pane-session-ownership.md\` §4.`,
  );
  lines.push(
    `4. Ask how it got in. A standing report here after the resolver fix (§1) ` +
      `means a **new** adoption shape, not a regression on a known one.`,
  );
  lines.push("");
  lines.push(`**Conversation:** \`${d.conversationId}\``);
  lines.push(`**Foreign session:** \`${d.foreignSessionId}\``);
  lines.push(`**Reason:** ${d.reason}`);
  if (d.reason === "directory-mismatch") {
    lines.push(`**Anchor dir:** \`${d.anchorDir}\``);
    lines.push(`**Foreign dir:** \`${d.foreignDir}\``);
  } else {
    lines.push(
      `**Also held by:** ${d.otherConversationIds.map((id) => `\`${id}\``).join(", ")}`,
    );
  }
  lines.push("");
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}

import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import {
  ForeignSessionPayloadSchema,
  type ForeignSessionPayload,
} from "@plugins/conversations/plugins/transcript-source/core";

// Re-alert the bell at most once per ~6h while a foreign entry stays in a chain.
// It is a standing data-loss condition — a rewind or fork of the conversation
// would cut a stranger's transcript — so it should resurface periodically
// without spamming.
const FOREIGN_SESSION_NOTIF_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * The `conversation-foreign-session` report kind: a session id offered to, or
 * recorded in, one conversation's chain that belongs elsewhere.
 *
 * Deduped per `(conversationId, foreignSessionId)`, so a standing condition
 * collapses to a single task whose `count` is how many times it was seen.
 *
 * Variant `warning`: nothing crashes. A `directory-mismatch` id is refused at
 * adoption, and the read path only ever opens files in the conversation's own
 * projects dir; what may still be wrong is a stored `shared-session-id` row,
 * which stays wrong until somebody deletes it.
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
    category: "error",
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
  if (d.reason === "directory-mismatch") {
    lines.push(
      `Conversation \`${d.conversationId}\` was offered session ` +
        `\`${d.foreignSessionId}\`, whose transcript was written in ` +
        `\`${d.foreignDir}\` — not in \`${d.anchorDir}\`, the projects dir ` +
        `its working directory names. The status reconciler refused the id.`,
    );
    lines.push("");
    lines.push(
      `**Two causes look like this.** (a) The runtime offered another ` +
        `conversation's session (mis-attribution — all of a conversation's ` +
        `sessions run in its one worktree). (b) Claude Code changed how it ` +
        `names a projects dir after the cwd (\`claudeProjectDirName\`, ` +
        `infra/paths): then EVERY new conversation is refused and reads empty, ` +
        `so many of these at once, each with a plausible-looking dir, means (b) ` +
        `— fix the encoding.`,
    );
    lines.push("");
    lines.push(
      `**Why (a) matters.** Adopting the id would make another agent's ` +
        `transcript this conversation's tail: a rewind would cut it and ` +
        `\`claude --resume\` would attach to it.`,
    );
    lines.push("");
  } else {
    lines.push(
      `Conversation \`${d.conversationId}\` has \`${d.foreignSessionId}\` in its ` +
        `recorded session chain (\`conversation_sessions\`), but that session ` +
        `belongs to a **different conversation**.`,
    );
    lines.push("");
    lines.push(
      `**How it was seen:** the same \`claude_session_id\` appears in the chain ` +
        `of ${d.otherConversationIds.length} other conversation(s): ` +
        `${d.otherConversationIds.map((id) => `\`${id}\``).join(", ")}. ` +
        `A Claude session belongs to exactly one conversation.`,
    );
    lines.push("");
    lines.push(
      `**Why it matters.** The stored row does not self-heal: writes ` +
        `target the chain tail, so while a foreign id is the tail, a rewind ` +
        `cuts another agent's transcript, and \`claude --resume\` on the stored ` +
        `\`conversations.claude_session_id\` attaches to that agent's session.`,
    );
    lines.push("");
  }

  lines.push(`**Triage**`);
  if (d.reason === "directory-mismatch") {
    lines.push(
      `1. Read the transcript's first \`cwd\` field: it is the directory the ` +
        `session really ran in. Encoded (every non-alphanumeric → \`-\`), does ` +
        `it give \`${d.foreignDir}\`'s name? If not, the encoding changed — (b).`,
    );
    lines.push(
      `2. Otherwise find which conversation ran that cwd and why the runtime ` +
        `reported its session for \`${d.conversationId}\` — (a).`,
    );
    lines.push("");
  } else {
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
  }
  lines.push(`**Conversation:** \`${d.conversationId}\``);
  lines.push(`**Foreign session:** \`${d.foreignSessionId}\``);
  lines.push(`**Reason:** ${d.reason}`);
  if (d.reason === "directory-mismatch") {
    lines.push(`**Its own dir:** \`${d.anchorDir}\``);
    lines.push(`**Born in:** \`${d.foreignDir}\``);
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

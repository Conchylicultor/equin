import {
  readConversationTurns,
  type Turn,
} from "@plugins/conversations/server";
import {
  getConversation,
  getTask,
} from "@plugins/tasks/plugins/tasks-core/server";

// Most transcripts fit comfortably in Sonnet's context. For very long ones
// we keep a head + tail of each turn's text so the model still sees both
// the original ask and recent activity, with the wandering middle dropped.
const TURN_TEXT_HEAD_CHARS = 2000;
const TURN_TEXT_TAIL_CHARS = 1000;

export interface PromptPayload {
  prompt: string;
  context: string;
  turnCount: number;
}

export async function buildSummarizePayload(
  targetConversationId: string,
  contextPath: string,
): Promise<PromptPayload> {
  const conv = await getConversation(targetConversationId);
  if (!conv) {
    throw new Error(
      `No conversation with id "${targetConversationId}" — cannot summarise.`,
    );
  }
  const task = conv.taskId ? await getTask(conv.taskId) : null;
  const turns = await readConversationTurns(targetConversationId);

  const sections: string[] = [];

  sections.push("<target-conversation>");
  sections.push(`  <id>${escapeText(targetConversationId)}</id>`);
  sections.push(`  <status>${escapeText(conv.status)}</status>`);
  if (conv.model) sections.push(`  <model>${escapeText(conv.model)}</model>`);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; legacy rows may have empty strings
  if (conv.kind) sections.push(`  <kind>${escapeText(conv.kind)}</kind>`);
  if (conv.title) sections.push(`  <title>${escapeText(conv.title)}</title>`);
  sections.push("</target-conversation>");
  sections.push("");

  sections.push("<task>");
  if (!task) {
    sections.push("  <!-- no task linked -->");
  } else {
    sections.push(`  <id>${escapeText(task.id)}</id>`);
    sections.push(`  <title>${escapeText(task.title)}</title>`);
    if (task.description)
      sections.push(
        `  <description>${escapeText(task.description)}</description>`,
      );
    sections.push(`  <status>${escapeText(task.status)}</status>`);
  }
  sections.push("</task>");
  sections.push("");

  sections.push("<transcript>");
  if (turns.length === 0) {
    sections.push("  <!-- empty: no turns recorded yet -->");
  } else {
    for (const turn of turns) {
      sections.push(formatTurn(turn));
    }
  }
  sections.push("</transcript>");

  const context = sections.join("\n");
  const prompt = INSTRUCTIONS(targetConversationId, contextPath);
  return { prompt, context, turnCount: turns.length };
}

function INSTRUCTIONS(
  targetConversationId: string,
  contextPath: string,
): string {
  return `You are summarising a single conversation so the user can monitor its progress.

The target conversation context (status, task, transcript) is at \`${contextPath}\`. Read that file first with the Read tool.

Then call \`mcp__equin__submit_conversation_summary\` EXACTLY ONCE with these fields:

- \`conversationId\`: must be exactly \`"${targetConversationId}"\`.
- \`phase\`: pick the enum value that best describes what's happening RIGHT NOW (see the tool's description for semantics). The enum is orthogonal to status (working/blocked/done is surfaced separately) — focus on *what kind of activity*.
- \`phaseDetail\`: required if phase='other', optional otherwise.
- \`nextAction\`: a concrete next step the user (or another agent) should take.
- \`flags\`: anything notable — surprises, risks, blockers, scope creep. Omit if nothing.
- \`notes\`: anything else worth recording.

After the tool call succeeds, STOP. Do not write a final assistant message, do not read other files, do not run other tools.`;
}

function formatTurn(turn: Turn): string {
  const text = truncateHeadTail(
    turn.text.trim(),
    TURN_TEXT_HEAD_CHARS,
    TURN_TEXT_TAIL_CHARS,
  );
  return `  <turn role="${escapeAttr(turn.role)}" at="${escapeAttr(turn.at)}">${escapeText(text)}</turn>`;
}

function truncateHeadTail(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text;
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)}\n…[truncated ${dropped} chars]…\n${text.slice(-tail)}`;
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

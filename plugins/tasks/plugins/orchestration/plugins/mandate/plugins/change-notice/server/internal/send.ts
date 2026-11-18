import { MCP_SERVER_NAME } from "@plugins/infra/plugins/mcp/core";
import { Runtime, submitTurn } from "@plugins/conversations/server";
import { refreshSections } from "@plugins/conversations/plugins/system-prompt/plugins/composer/server";
import type { SystemPromptSection } from "@plugins/conversations/plugins/system-prompt/server";
import { noticeText } from "./notice";

/** What a change notice carries: what changed, and the sections it touches. */
export interface SectionNotice {
  /** What changed, said as information only — never a request to act. */
  lead: string;
  /** The system-prompt sections the change touches. */
  pick: (section: SystemPromptSection) => boolean;
  /**
   * Whether the change also moves the agent's equin MCP tools (a mandate
   * change): the server is reconnected first, and the notice is sent even
   * when no picked section has anything to say — the tools changed.
   */
  reconnectMcp: boolean;
}

/**
 * Tells one live agent that the sections `notice.pick` selects changed under
 * it: its system prompt is fixed for the life of its process, so they are
 * rendered again and sent as an event turn, typed now the way a user message
 * is (a working agent reads it at its next step). An agent this backend does
 * not run (another namespace's, hibernated, or none) gets nothing — its next
 * spawn renders them anyway; nor does one none of the picked sections speaks
 * to, now or at its spawn.
 */
export async function sendSectionNotice(
  conversation: { id: string; runtime: string },
  notice: SectionNotice,
): Promise<void> {
  const { id } = conversation;
  const runtime = Runtime.get(conversation.runtime);
  if (notice.reconnectMcp) {
    const outcome = await runtime.reconnectMcp(id, MCP_SERVER_NAME);
    if (outcome === "not-running") return;
  } else if (!(await runtime.isRunning(id))) return;
  const sections = await refreshSections(id, notice.pick);
  if (sections.length === 0 && !notice.reconnectMcp) return;
  const text = noticeText(notice.lead, sections);
  const out = await submitTurn(id, { kind: "event", text, typedText: text });
  if (out.kind === "not-found")
    throw new Error(`section notice: conversation ${id} not found`);
  if (out.kind === "stopped")
    throw new Error(
      `section notice: conversation ${id} stopped (${out.status}) before the notice reached it`,
    );
}

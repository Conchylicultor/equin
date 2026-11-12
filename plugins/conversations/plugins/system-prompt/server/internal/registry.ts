import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";

/**
 * One plugin's part of what equin appends to an agent's system prompt — the
 * channel for context about THIS agent and its task (its mandate, the global
 * page instructions, its task tree), as opposed to how to use a tool (the
 * tool's own description).
 *
 * `render` runs at every spawn of the agent's process — its launch and every
 * resume — right before the process starts, so what it returns is what that
 * process runs with until it stops. A change while it runs reaches it as an
 * event turn, from the plugin that owns the change. `null` (or blank) adds
 * nothing. Sections join in id order, each wrapped in `<equin-context id>`.
 *
 * Nothing caps the system prompt the way MCP server instructions are capped
 * (4,096 characters, cut silently), but every character is paid on every turn:
 * write only what no tool description, gate or CLAUDE.md already says. The
 * context card shows each section's share.
 */
export interface SystemPromptSection {
  /** Stable id: the wrapper's `id`, the record's key, the order. */
  id: string;
  /** What the context card calls it ("Mandate", "Task tree"). */
  label: string;
  render(conversationId: string): Promise<string | null>;
}

export const SystemPrompt = {
  Section: defineServerContribution<SystemPromptSection>(
    "conversations.system-prompt.section",
    { docLabel: (s) => s.id },
  ),
};

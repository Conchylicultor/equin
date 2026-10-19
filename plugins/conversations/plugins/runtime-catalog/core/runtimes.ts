import { z } from "zod";

/**
 * The runtimes a conversation can run on — a closed list both halves need (the
 * runtime registry's ids, the default-runtime config, the Runtime launch
 * option's choices):
 *
 * - `tmux` — the interactive Claude Code CLI in a tmux pane, driven by
 *   keystrokes and screen reading (conversations/runtime-tmux);
 * - `sdk` — one Agent SDK process per conversation, driven over a socket
 *   (conversations/runtime-sdk), hosted in tmux only as a supervisor.
 */
export const CONVERSATION_RUNTIMES = {
  tmux: {
    label: "Terminal",
    description:
      "The interactive Claude Code CLI in a tmux pane, driven by typing into it.",
    /** The terminal button types into the pane: it IS the session's UI. */
    terminal: "interactive",
  },
  sdk: {
    label: "Agent SDK",
    description:
      "A headless Claude Code session through the Agent SDK, driven over a socket — exact busy/idle, no typing.",
    /**
     * The pane only shows the agent's log: attached read-only, so a Ctrl-C
     * typed into it never reaches the agent process.
     */
    terminal: "read-only",
  },
} as const;

export type ConversationRuntimeId = keyof typeof CONVERSATION_RUNTIMES;

export const CONVERSATION_RUNTIME_IDS = Object.keys(
  CONVERSATION_RUNTIMES,
) as ConversationRuntimeId[];

export const ConversationRuntimeIdSchema = z.enum(
  CONVERSATION_RUNTIME_IDS as [
    ConversationRuntimeId,
    ...ConversationRuntimeId[],
  ],
);

/** The runtime named by a conversation row's `runtime`; throws on an unknown id. */
export function conversationRuntimeInfo(
  id: string,
): (typeof CONVERSATION_RUNTIMES)[ConversationRuntimeId] {
  const parsed = ConversationRuntimeIdSchema.parse(id);
  return CONVERSATION_RUNTIMES[parsed];
}

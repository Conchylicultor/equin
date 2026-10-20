import { z } from "zod";

/**
 * The runtimes a conversation can run on — a closed list both halves need (the
 * runtime registry's ids, a conversation row's `runtime`):
 *
 * - `sdk` — one Agent SDK process per conversation, driven over a socket
 *   (conversations/runtime-sdk), hosted in tmux only as a supervisor and a
 *   read-only view.
 */
export const CONVERSATION_RUNTIMES = {
  sdk: {
    label: "Agent SDK",
    description:
      "A headless Claude Code session through the Agent SDK, driven over a socket.",
  },
} as const;

export type ConversationRuntimeId = keyof typeof CONVERSATION_RUNTIMES;

/** What a new conversation runs on unless its launch names a runtime. */
export const DEFAULT_CONVERSATION_RUNTIME: ConversationRuntimeId = "sdk";

export const CONVERSATION_RUNTIME_IDS = Object.keys(
  CONVERSATION_RUNTIMES,
) as ConversationRuntimeId[];

export const ConversationRuntimeIdSchema = z.enum(
  CONVERSATION_RUNTIME_IDS as [
    ConversationRuntimeId,
    ...ConversationRuntimeId[],
  ],
);

import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import {
  ConversationStatusSchema,
  type ConversationStatus,
} from "@plugins/tasks/plugins/tasks-core/core";
import { closeConversationSession } from "./host-client";

/**
 * Whether a conversation in this status has an agent left to drive a browser.
 * Every status is named, so a new one is a type error here until someone
 * decides. `gone` (its process died) can resume; it then opens a new session.
 */
const HAS_AGENT: Record<ConversationStatus, boolean> = {
  starting: true,
  working: true,
  waiting: true,
  gone: false,
  done: false,
};

/** Close a conversation's browser session (reverting its writes) when it ends. */
export const browserConversationEndedJob = defineJob({
  name: "mcp-browser.conversation-ended",
  description:
    "Closes an agent's headless browser session (and reverts the writes it made) when its conversation ends or its agent dies.",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z
    .object({ conversationId: z.string(), status: ConversationStatusSchema })
    .passthrough(),
  run: async ({ event }) => {
    if (!event || HAS_AGENT[event.status]) return;
    await closeConversationSession(event.conversationId);
  },
});

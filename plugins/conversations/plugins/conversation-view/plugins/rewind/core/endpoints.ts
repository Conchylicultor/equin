import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import {
  RewindOutcomeSchema,
  RewindPreviewSchema,
} from "@plugins/conversations/core";

/** The transcript line uuid of the user message to go back to (the `user-text` row's `uuid`). */
const RewindBodySchema = z.object({ uuid: z.string().min(1) });

/**
 * What going back to this message would keep and lose. Reads only, and computed
 * by the same cut the rewind and the fork perform — so the dialog the user
 * confirms cannot describe a different cut than the one that then happens.
 */
export const previewRewindEndpoint = defineEndpoint({
  route: "POST /api/conversations/:id/rewind/preview",
  body: RewindBodySchema,
  response: RewindPreviewSchema,
  // It reads the agent's transcript off the computer.
  needsMachine: { feature: "Rewinding a conversation" },
});

/**
 * Continue this conversation from just before the message. A refusal is a
 * normal answer (`ok: false` + a message to show), and leaves the conversation
 * untouched.
 */
export const rewindConversationEndpoint = defineEndpoint({
  route: "POST /api/conversations/:id/rewind",
  body: RewindBodySchema,
  response: RewindOutcomeSchema,
  needsMachine: { feature: "Rewinding a conversation" },
});

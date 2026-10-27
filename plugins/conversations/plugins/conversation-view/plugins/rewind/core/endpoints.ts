import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { RewindOutcomeSchema } from "@plugins/conversations/core";
import { REWINDING } from "./resources";

/** The transcript line uuid of the user message to go back to (the `user-text` row's `uuid`). */
const RewindBodySchema = z.object({ uuid: z.string().min(1) });

/**
 * Continue this conversation from just before the message. A refusal is a
 * normal answer (`ok: false` + a message to show), and leaves the conversation
 * untouched.
 */
export const rewindConversationEndpoint = defineEndpoint({
  route: "POST /api/conversations/:id/rewind",
  body: RewindBodySchema,
  response: RewindOutcomeSchema,
  needsMachine: REWINDING,
});

import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// The prompt text comes from the CLIENT, not from the block row: the
// `doc → data.text` projection lags the CRDT doc by ~1s, so a launch right after
// typing would stamp stale text. An empty prompt is rejected (400) rather than
// silently creating a task with no description.
const CreatePromptBlockTaskBodySchema = z.object({
  pageId: z.string().min(1),
  blockId: z.string().min(1),
  prompt: z.string().min(1),
});

export const createPromptBlockTask = defineEndpoint({
  route: "POST /api/prompt-blocks/tasks",
  body: CreatePromptBlockTaskBodySchema,
  response: z.object({ taskId: z.string() }),
});
export type CreatePromptBlockTaskBody = z.infer<typeof CreatePromptBlockTaskBodySchema>;

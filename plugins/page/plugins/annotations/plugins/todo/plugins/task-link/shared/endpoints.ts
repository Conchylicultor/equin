import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// Dispatch an agent onto one TODO card: return the card's task (creating it the
// first time) and the prompt the agent should be launched with.
//
// IDEMPOTENT, and it is the only place the one-task-per-card rule is exercised.
// A second dispatch from the same card returns the SAME task id, which is what
// makes it a second ATTEMPT rather than a second task: `createConversation` with
// a `taskId` and no `attemptId` already mints a new attempt.
//
// The card's text is NOT in the body. Unlike `/prompt` — whose text the client
// must send because the block row's `data.text` projection lags the CRDT doc by
// ~1s — a TODO card owns no text of its own: its content is its children, each
// with its own doc, and there is no single editor holding a fresher copy. So the
// server reads the card as markdown, which is also exactly what the agent will
// re-read through `read_page`.
const CreateTodoBlockTaskBodySchema = z.object({
  /** Free-form extra context the user typed into the dispatch panel. */
  context: z.string().optional(),
});

export const createTodoBlockTask = defineEndpoint({
  route: "POST /api/todo-blocks/:blockId/task",
  body: CreateTodoBlockTaskBodySchema,
  response: z.object({ taskId: z.string(), prompt: z.string() }),
});
export type CreateTodoBlockTaskBody = z.infer<
  typeof CreateTodoBlockTaskBodySchema
>;

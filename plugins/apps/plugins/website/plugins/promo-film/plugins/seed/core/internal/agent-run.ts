import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/**
 * The agent run behind a task the film's Wish filed, finished: the film's
 * instance never launches an agent (a task filed off main is never started),
 * so the recording asks for the run the agent would have made — its attempt,
 * its conversation (waiting on the user) and its transcript — on the task the
 * Wish really created, found by its prompt. Refused anywhere but the film's
 * own instance, like the seed.
 */
export const finishFilmAgentRun = defineEndpoint({
  route: "POST /api/promo-film/agent-run",
  body: z.object({
    prompt: z.string(),
    /** The recording page's now (epoch ms, its pinned film calendar): the run's "just finished". */
    now: z.number().int(),
  }),
  response: z.object({ taskId: z.string(), conversationId: z.string() }),
  needsMachine: { feature: "Finishing the showcase film's agent run" },
});

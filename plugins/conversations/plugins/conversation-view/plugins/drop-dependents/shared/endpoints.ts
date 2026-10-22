import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

export const dropDependents = defineEndpoint({
  route: "POST /api/conversations/:id/drop-dependents",
  // `kept`: another conversation on the task is still running, so only this
  // conversation closed — the task and its dependents stay as they were.
  response: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("dropped"), count: z.number() }),
    z.object({ kind: z.literal("kept"), reason: z.literal("active-sibling") }),
  ]),
});

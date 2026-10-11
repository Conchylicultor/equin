import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/** Re-read one sidequest now (a stale or wrong triage) — read-only Sonnet. */
export const retriageEndpoint = defineEndpoint({
  route: "POST /api/sidequest-autopilot/triage/:taskId/run",
});

/**
 * The person's one-click answer to triage's question (`null` clears it). Fed
 * to the agent as `{{decision}}`; it approves nothing.
 */
export const answerTriageEndpoint = defineEndpoint({
  route: "PUT /api/sidequest-autopilot/triage/:taskId/answer",
  body: z.object({ answer: z.string().min(1).nullable() }),
});

import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

export const StopGateResponseSchema = z.object({
  /** `block`: the agent must go on — `reason` says why, and is what it reads. */
  decision: z.enum(["allow", "block"]),
  /**
   * `block`: every blocking gate's reason, joined. `allow`: the waivers'
   * reasons when a gate blocked but was waived (for the log), else null.
   */
  reason: z.string().nullable(),
});
export type StopGateResponse = z.infer<typeof StopGateResponseSchema>;

/**
 * The conversation's agent is about to end its turn: may it? Every StopGate
 * contribution is asked; the Stop hook prints the answer back to the CLI.
 */
export const stopGate = defineEndpoint({
  route: "GET /api/conversations/:id/stop-gate",
  response: StopGateResponseSchema,
});

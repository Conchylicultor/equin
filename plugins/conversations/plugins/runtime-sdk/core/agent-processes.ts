import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

export const AgentProcessesSchema = z.object({
  /** SDK agent processes this backend's namespace launched that are alive. */
  here: z.number().int().nonnegative(),
  /** Every other namespace on the machine with live agents, by namespace. */
  elsewhere: z.array(
    z.object({
      namespace: z.string(),
      running: z.number().int().positive(),
    }),
  ),
});
export type AgentProcesses = z.infer<typeof AgentProcessesSchema>;

/**
 * How many SDK agent processes are running on the machine: this backend's own
 * and every other namespace's, read off the agents' pid files (a file whose pid
 * is gone — an agent killed outright — does not count). Read off the computer,
 * so only the desktop app answers it (`needsMachine`).
 */
export const sdkAgentProcesses = liveValue("runtime-sdk.agent-processes", {
  schema: AgentProcessesSchema,
  needsMachine: { feature: "Counting the running agent processes" },
});

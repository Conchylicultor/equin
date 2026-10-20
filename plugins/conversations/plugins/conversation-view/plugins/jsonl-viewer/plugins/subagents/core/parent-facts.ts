import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  JsonlEventSchema,
  type JsonlEvent,
} from "@plugins/conversations/plugins/transcript-source/core";
import { agentCallsIn } from "./join";
import { agentResumeTimes } from "./resume";
import { teammateIdleTimes } from "./teammate-idle";
import { workflowCallsIn } from "./workflow-join";

/**
 * What sub-agent state needs from the PARENT transcript, folded over all of it.
 *
 * The conversation pane holds only its latest events, but a sub-agent's launch
 * (`Agent` call), completion (`task-notification`), resume and idle can sit
 * anywhere in the transcript — so the server reduces the whole transcript to
 * these few events and two small maps, and the page joins them to the
 * sub-agent rows as before. Events keep their transcript order.
 */
export const ParentFactsSchema = z.object({
  /** Every `task-notification` event. */
  taskNotifications: z.array(JsonlEventSchema),
  /** Every `Agent` tool-call (`agentCallsIn`) — with its result, the sub-agent's handback. */
  agentCalls: z.array(JsonlEventSchema),
  /** Every `Workflow` tool-call (`workflowCallsIn`). */
  workflowCalls: z.array(JsonlEventSchema),
  /** `teammateIdleTimes`, by teammate name. */
  idleTimes: z.record(z.string(), z.string()),
  /** `agentResumeTimes`, by agent id. */
  resumeTimes: z.record(z.string(), z.string()),
});
export type ParentFacts = z.infer<typeof ParentFactsSchema>;

/** The server-side fold: a whole parent transcript → {@link ParentFacts}. */
export function parentFactsOf(events: readonly JsonlEvent[]): ParentFacts {
  return {
    taskNotifications: events.filter((e) => e.kind === "task-notification"),
    agentCalls: agentCallsIn(events),
    workflowCalls: workflowCallsIn(events),
    idleTimes: Object.fromEntries(teammateIdleTimes(events)),
    resumeTimes: Object.fromEntries(agentResumeTimes(events)),
  };
}

/** The served value, keyed by the parent conversation's id. */
export const conversationParentFacts = liveValue("subagents.parent-facts", {
  schema: ParentFactsSchema,
  params: ["id"],
});

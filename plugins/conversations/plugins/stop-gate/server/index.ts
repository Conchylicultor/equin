import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { stopGate } from "../core";
import { handleStopGate } from "./internal/handler";

export { StopGate, StopWaiver } from "./internal/registry";
export type {
  StopGateEntry,
  StopVerdict,
  StopWaiverEntry,
} from "./internal/registry";

export default {
  portable: true,
  description:
    "The stop-gate backend: the StopGate contribution (a plugin's check(conversationId) — block the agent's stop while it still owes the plugin something, with the reason it reads) and the StopWaiver contribution (waives(conversationId) — the agent may stop anyway, it will be woken), and the GET /api/conversations/:id/stop-gate endpoint the Stop hook asks: block iff some gate blocks and no waiver waives.",
  httpRoutes: {
    [stopGate.route]: handleStopGate,
  },
} satisfies ServerPluginDefinition;

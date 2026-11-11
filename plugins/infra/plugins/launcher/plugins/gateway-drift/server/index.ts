import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { gatewayRestartFailedKind } from "./internal/restart-failed-kind";

export default {
  description:
    "The gateway-restart-failed report kind — filed through the report outbox by main's convergence run when its follow-main step could not bring the machine's gateway onto main's (the new gateway did not come up, rolled back or not, or it refused because it could not have gone back).",
  contributions: [gatewayRestartFailedKind],
} satisfies ServerPluginDefinition;

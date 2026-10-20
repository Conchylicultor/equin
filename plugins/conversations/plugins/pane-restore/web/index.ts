import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import "./internal/pane-restore-store";

export { loadRouteForConversation } from "./internal/pane-restore-store";
export type { RouteRestore } from "./internal/pane-restore-store";

export default {
  description:
    "Saves and restores the pane route per conversation in the budgeted web storage.",
  contributions: [],
} satisfies PluginDefinition;

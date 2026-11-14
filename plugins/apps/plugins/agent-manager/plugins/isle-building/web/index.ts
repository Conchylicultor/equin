import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Isle } from "@plugins/apps/plugins/isle/plugins/buildings/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { forge } from "../core";

export default {
  description:
    "The Agent Manager's building on Isle: the workshop forge, a brass automaton hammering at its bench.",
  contributions: [Isle.Building({ app: agentManagerApp, building: forge })],
} satisfies PluginDefinition;

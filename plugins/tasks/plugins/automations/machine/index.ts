import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { automationsCatalogServed } from "./internal/catalog";
import { automationTasksServed } from "./internal/history";

export default {
  description:
    "The automations' live reads, desktop-only half: the automations.catalog value (every registered automation with its settings, installed trigger and open / running tasks) and the automations.tasks history (the tasks each one filed or launched) — both needsMachine, so a host without the computer answers them unavailable.",
  contributions: [
    ...automationsCatalogServed.declare,
    ...automationTasksServed.declare,
  ],
} satisfies MachinePluginDefinition;

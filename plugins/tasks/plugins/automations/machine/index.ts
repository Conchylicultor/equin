import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { automationsCatalogServed } from "./internal/catalog";

export default {
  description:
    "The automations.catalog live value, desktop-only half: every registered automation with its settings, installed trigger and open / running tasks — served here while the automations it lists are config-bound, so a host without the computer answers it unavailable.",
  contributions: [...automationsCatalogServed.declare],
} satisfies MachinePluginDefinition;

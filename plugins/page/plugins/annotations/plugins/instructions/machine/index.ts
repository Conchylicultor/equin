import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { instructionsDeliveriesRetention } from "./internal/growth-bound";

export default {
  description:
    "Instructions, desktop-only half: the nightly retention sweep bounding page_instructions_deliveries (deliveries older than 30 days, per worktree DB).",
  register: [instructionsDeliveriesRetention],
} satisfies MachinePluginDefinition;

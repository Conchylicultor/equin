import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { entityVersionsRetention } from "./internal/retention";

export default {
  description:
    "Version history, desktop-only half: the 30-day retention sweep over entity_versions (its growth bound).",
  register: [entityVersionsRetention],
} satisfies MachinePluginDefinition;

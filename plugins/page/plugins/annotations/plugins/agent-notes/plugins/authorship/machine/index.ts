import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import "./internal/growth-bound";

export default {
  description:
    "The agent-card authorship table's growth bound, desktop-only half: `page_blocks_agent_authors` is reclaimed by its cascade to page_blocks, checked at boot by the retention primitive (markCascadeBounded).",
} satisfies MachinePluginDefinition;

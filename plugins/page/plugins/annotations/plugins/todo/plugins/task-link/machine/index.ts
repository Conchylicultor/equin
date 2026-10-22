import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import "./internal/growth-bound";

export default {
  description:
    "The todo-card task links table's growth bound, desktop-only half: `page_blocks_ext_todo_task` is reclaimed by its cascade to page_blocks, checked at boot by the retention primitive (markCascadeBounded).",
} satisfies MachinePluginDefinition;

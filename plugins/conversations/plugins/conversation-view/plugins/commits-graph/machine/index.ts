import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { commitsGraphServed } from "./internal/resources";

export default {
  description:
    "Toolbar chip showing commits ahead/behind main; opens a side pane with the chain of commits between merge-base and HEAD. Desktop-only: the commits-graph.graph value reads the attempt's checkout with git (needsMachine).",
  contributions: [...commitsGraphServed.declare],
} satisfies MachinePluginDefinition;

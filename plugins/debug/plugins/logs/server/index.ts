import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { logLinesServed, logsCatalogServed } from "./internal/served";

export default {
  description:
    "The debug.logs.catalog value (every log of a worktree with its files' sizes and ages) and the debug.logs.lines paged value (one log's lines across its whole kept history), each watched through the dir hub.",
  contributions: [...logsCatalogServed.declare, ...logLinesServed.declare],
} satisfies ServerPluginDefinition;

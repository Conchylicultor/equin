import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { turnSummaryRowsServed } from "./internal/resource";

export { turnSummaries } from "./internal/tables";

export default {
  portable: true,
  description:
    "Serves each conversation's latest turn summary (a one-line summary, caveats list, and actions list) rendered above the prompt input. The Haiku job that writes it after every assistant turn, and its config, live in the machine half.",
  contributions: [...turnSummaryRowsServed.declare],
} satisfies ServerPluginDefinition;

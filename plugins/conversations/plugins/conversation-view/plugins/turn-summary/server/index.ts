import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { turnSummaryRowsServed } from "./internal/resource";
import { turnSummaryConfig } from "../shared/config";

export { turnSummaries } from "./internal/tables";

export default {
  portable: true,
  description:
    "Serves each conversation's latest turn summary (a one-line summary, caveats list, and actions list) rendered above the prompt input, and registers the turn-summary config. The Haiku job that writes it after every assistant turn lives in the machine half.",
  contributions: [
    ConfigV2.Register({ descriptor: turnSummaryConfig }),
    ...turnSummaryRowsServed.declare,
  ],
} satisfies ServerPluginDefinition;

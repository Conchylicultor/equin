import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { pluginHealthReviewsServed } from "./internal/resource";
import { proposeTaskTool } from "./internal/mcp-tools";
import { pluginStalenessServed } from "./internal/staleness";
import { reviewTaskCountsServed } from "./internal/review-tasks";
import { IdKinds } from "@plugins/ids/server";
import { pluginReviewIdKind } from "../core";

export { healthReviewExt } from "./internal/tables";

export default {
  description: "Per-plugin health review tracking.",
  contributions: [
    IdKinds.Kind({ kind: pluginReviewIdKind }),
    ...pluginHealthReviewsServed.declare,
    ...pluginStalenessServed.declare,
    ...reviewTaskCountsServed.declare,
  ],
  register: [proposeTaskTool],
} satisfies ServerPluginDefinition;

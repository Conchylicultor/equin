import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { activityServed } from "./internal/served";

export { activityServed } from "./internal/served";

export default {
  description:
    "Recent activity as ONE routed union window (a Meta-DataView): activityServed serves the `activity` collection's window, `:rows` and `:groups` from every arm bound through activityServed.arm — each kind of record's own table, its entity's exposed extension fields folded into its band. Names no kind.",
  contributions: [...activityServed.declare],
} satisfies ServerPluginDefinition;

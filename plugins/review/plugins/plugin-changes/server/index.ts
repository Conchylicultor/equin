import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { pushPluginChangesServed } from "./internal/push-plugin-changes";

export default {
  description:
    "Computes structured diffs of plugin public APIs between the worktree and main, and serves one push's (review.push-plugin-changes).",
  contributions: [...pushPluginChangesServed.declare],
} satisfies ServerPluginDefinition;

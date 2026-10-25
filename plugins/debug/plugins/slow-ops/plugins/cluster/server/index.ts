import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { clusterScanServed } from "./internal/scan-served";

export { listLiveForkDatabases } from "./internal/live-fork-databases";

export default {
  description:
    "Cross-worktree cluster scan: every live worktree DB fork's heaviest slow_ops, served as the debug.slow-ops.cluster.scan live value — one scan per Refresh, pushed as each fork answers.",
  contributions: [...clusterScanServed.declare],
} satisfies ServerPluginDefinition;

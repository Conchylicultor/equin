import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { pushFilesServed } from "./internal/commit-values";

export {
  resolveWorkspaceRoot,
  resolveWorktreePath,
} from "./internal/resolve-worktree-path";
export { getRangeFiles } from "./internal/get-push-files";
export {
  pushRangeReads,
  resolvePushRange,
  type PushRange,
} from "./internal/push-range";

export default {
  description:
    "Worktree-scoped checkout reads by attempt id or the reserved `main` sentinel: push-files — one push's files, its range read from its ledger rows by ancestry. The raw image route is the machine half's.",
  contributions: [...pushFilesServed.declare],
} satisfies ServerPluginDefinition;

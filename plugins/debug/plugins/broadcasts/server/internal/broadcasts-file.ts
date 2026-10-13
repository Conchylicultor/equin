import { join } from "node:path";
import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";

/**
 * The broadcasts file in the main checkout — the one the CLI's op-runtime
 * reads (as committed on `origin/main`) to print broadcasts on stale branches.
 */
export async function broadcastsPath(): Promise<string> {
  const root = await ensureMainWorktreeRoot();
  return join(root, "plugins/framework/plugins/cli/broadcasts.json");
}

import { serveValue } from "@plugins/network/plugins/live/machine";
import { workspaceRoot } from "@plugins/code-explorer/plugins/code-api/core";
import { loadWorkspaceRoot, workspaceRootReads } from "./workspace";

// Notified by the attempt row alone (its declared `reads`): `"main"`, `"self"`
// and a checkout toplevel resolve the same for the life of the process.
export const workspaceRootServed = serveValue(workspaceRoot, {
  source: "external",
  changes: "notified",
  reads: workspaceRootReads,
  loader: async ({ worktree }) => {
    const root = await loadWorkspaceRoot(worktree);
    if (root === null) {
      throw workspaceRoot.refuse("no-workspace", `no workspace ${worktree}`);
    }
    return root;
  },
});

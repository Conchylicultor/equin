import { serveValue } from "@plugins/network/plugins/live/machine";
import { attemptWorkspacesServed } from "@plugins/tasks/plugins/tasks-core/server";
import { workspaceRoot } from "@plugins/code-explorer/plugins/code-api/core";
import {
  workspaceAttemptIds,
  workspaceRootFrom,
} from "../../server/internal/resolve-worktree-path";

// Notified by the attempt row alone, FOLLOWED (`attemptWorkspaces` by the
// id's attempt — none for a sentinel or a path): `"main"`, `"self"` and a
// checkout toplevel resolve the same for the life of the process, and only a
// write to THAT attempt's workspace columns re-reads the tuple.
export const workspaceRootServed = serveValue(workspaceRoot, {
  source: "external",
  changes: "notified",
  follows: (follow) => ({
    ws: follow(attemptWorkspacesServed, ({ worktree }) => ({
      ids: workspaceAttemptIds(worktree),
    })),
  }),
  loader: async ({ worktree }, { followed }) => {
    const root = await workspaceRootFrom(worktree, followed.ws);
    if (root === null) {
      throw workspaceRoot.refuse("no-workspace", `no workspace ${worktree}`);
    }
    return root;
  },
});

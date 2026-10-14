import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * Scratch workspaces: one directory per scratch attempt (`<attemptId>/`), the
 * cwd of its conversations — the profile's `CLAUDE.md`, its materialized
 * inputs and whatever the agent writes. Reaped by `workspace.scratch-reap`
 * once the attempt's task has been done or dropped for a week.
 */
export const scratchWorkspacesDir = defineDataDir({
  kind: "state",
  name: "workspaces",
  owner: "conversations/workspace/scratch",
  description:
    "Scratch agent workspaces, one directory per attempt: the profile's CLAUDE.md, its inputs and the agent's own files",
  reclaim: {
    kind: "never",
    reason:
      "a scratch agent's working directory; the workspace.scratch-reap job deletes it a week after its task is done or dropped",
  },
});

export default [scratchWorkspacesDir];

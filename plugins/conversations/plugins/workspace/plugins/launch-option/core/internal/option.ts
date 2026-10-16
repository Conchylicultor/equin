import {
  WorkspaceSpecSchema,
  type WorkspaceSpec,
} from "@plugins/conversations/plugins/workspace/core";
import { defineLaunchOption } from "@plugins/tasks/plugins/launch-options/core";

/**
 * Where the task's attempt runs. `null` = the default worktree; a scratch spec
 * names its profile (input `{}`: only profiles whose input has defaults are
 * pickable from a task — the server's parse fills them in).
 */
export const workspaceLaunchOption = defineLaunchOption<WorkspaceSpec | null>({
  id: "workspace",
  schema: WorkspaceSpecSchema.nullable(),
  defaultValue: null,
});

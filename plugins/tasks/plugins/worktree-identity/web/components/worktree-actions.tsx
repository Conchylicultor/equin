import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { appLinkProps } from "@plugins/apps-core/plugins/tabs/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { taskDetailRoute } from "@plugins/tasks/plugins/tasks-core/core";
import {
  useLinkedTask,
  useWorktreePlace,
} from "../internal/use-worktree-identity";
import { navIcons } from "@plugins/ui/plugins/icons/core";

/**
 * The worktree row's trailing controls: copy the namespace, and open the linked
 * task in the agent manager. Nothing to copy on a page served outside the
 * gateway; no "Open task" until a task is known to be linked.
 */
export function WorktreeActions() {
  const place = useWorktreePlace();
  const task = useLinkedTask(place);
  return (
    <>
      {place.kind === "local" ? null : (
        <CopyButton text={place.namespace} tooltip="Copy namespace" />
      )}
      {task.kind === "linked" ? (
        <IconButton
          icon={navIcons.expand}
          label="Open task"
          {...appLinkProps(
            taskDetailRoute.link(agentManagerApp, { taskId: task.taskId }),
          )}
        />
      ) : null}
    </>
  );
}

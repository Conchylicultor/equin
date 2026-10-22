import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import type { TaskListItem } from "@plugins/tasks/plugins/tasks-core/core";
import { patchTask } from "@plugins/tasks/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const deleteIcon = symbol("delete");

// "Delete" is a soft drop: it marks the task dropped (reversible via the
// task header's Undrop), never removing the row. Tasks are never hard-deleted.
export function DeleteTaskAction({
  row,
  hasChildren,
}: ItemActionProps<TaskListItem>) {
  const taskId = row.id;
  const fetchEndpoint = useFetchEndpoint();
  const disabled = hasChildren;
  const title = disabled
    ? "Only leaf tasks can be dropped here — drop the children first"
    : "Drop task";

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled) return;
    return patchTask(fetchEndpoint, taskId, { drop: true });
  };

  return (
    // aria-disabled (not the native `disabled` attribute) so the button still
    // receives hover events and the tooltip explaining *why* it's disabled can
    // appear; onClick early-returns when disabled.
    <ControlSizeProvider size="sm">
      <IconButton
        icon={deleteIcon}
        label="Drop task"
        tooltip={title}
        variant="ghost"
        onClick={onClick}
        aria-disabled={disabled}
        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-30"
      />
    </ControlSizeProvider>
  );
}

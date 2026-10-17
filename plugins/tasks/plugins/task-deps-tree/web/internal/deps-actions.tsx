import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  defineItemActions,
  type ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { removeTaskDependency } from "@plugins/tasks/core";
import type {
  TaskListItem,
  TaskRow,
} from "@plugins/tasks/plugins/tasks-core/core";
import type { DepsTreeRow } from "@plugins/tasks/plugins/task-deps-tree/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const closeIcon = symbol("close");
const linkOffIcon = symbol("link-off");

// The deps-tree row-action slot. Contributed into by web/index.ts and passed to
// the DataView via `itemActions`; every view renders its contributions in the
// row's trailing affordance.
export const DepsActions = defineItemActions<DepsTreeRow<TaskRow>>();

/**
 * Detach: remove the edge to this row's rendered (primary) parent, so the task
 * becomes a root of the tree — its subtree follows (no heal). Hidden for roots,
 * which have no rendered parent edge to cut.
 */
export function DetachAction({ row }: ItemActionProps<DepsTreeRow>) {
  const parentId = row.depsParentId;
  if (parentId == null) return null;

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    return fetchEndpoint(removeTaskDependency, { id: row.id, depId: parentId });
  };

  return (
    <ControlSizeProvider size="sm">
      <IconButton
        icon={linkOffIcon}
        label="Detach from parent"
        tooltip="Detach — make this a root"
        variant="ghost"
        onClick={onClick}
      />
    </ControlSizeProvider>
  );
}

/**
 * Fan-in prerequisites beyond the primary parent, rendered as compact removable
 * chips in the tree row's persistent trailing slot. The whole chip is the remove
 * affordance (a leading ×); "also after" chips carry no navigation.
 */
export function AlsoAfterChips({ row }: { row: DepsTreeRow }) {
  if (row.extraDeps.length === 0) return null;
  return (
    <Inline gap="2xs">
      {row.extraDeps.map((dep) => (
        <AlsoAfterChip key={dep.id} taskId={row.id} dep={dep} />
      ))}
    </Inline>
  );
}

function AlsoAfterChip({ taskId, dep }: { taskId: string; dep: TaskListItem }) {
  const title = dep.title || "Untitled";
  const remove = (e: React.MouseEvent) => {
    e.stopPropagation();
    return fetchEndpoint(removeTaskDependency, { id: taskId, depId: dep.id });
  };
  return (
    <Badge
      as="button"
      type="button"
      variant="muted"
      shape="pill"
      icon={<Icon icon={closeIcon} />}
      tooltip={`also after: ${title} — click to remove`}
      onClick={remove}
      className="hover:text-destructive"
    >
      also after: {title}
    </Badge>
  );
}

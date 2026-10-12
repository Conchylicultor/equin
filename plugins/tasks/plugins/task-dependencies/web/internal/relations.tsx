import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { removeTaskDependency } from "@plugins/tasks/core";
import {
  TaskGraph,
  isSettled,
  type TaskListItem,
} from "@plugins/tasks/plugins/tasks-core/core";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const closeIcon = symbol("close");

/**
 * One direction of the SAME edge (`task_dependencies`), read from the task the
 * detail pane is showing: the tasks it runs after, and the tasks it blocks.
 *
 * Plain data rather than a slot: an edge has exactly two ends, so this set is
 * closed by the shape of the relation itself — a contribution point here would
 * advertise an extensibility that cannot exist. What it DOES buy is that the
 * chip, its remove call, and the empty-state logic are written once and the two
 * directions cannot drift (they did: the two former sections were near-identical
 * files that had to be kept in sync by hand).
 */
export interface RelationDirection {
  id: "prerequisites" | "dependents";
  /** Group label in the card body. Verb phrase read off the shown task. */
  label: string;
  /** The ids related to `taskId` in this direction. */
  idsFor(taskId: string, tasks: readonly TaskListItem[]): readonly string[];
  /**
   * The `removeTaskDependency` edge for (shown task, related task). The two
   * directions are the same row read from opposite ends, which is exactly the
   * asymmetry that made the duplicated chip components dangerous.
   */
  edge(taskId: string, otherId: string): { id: string; depId: string };
  /** Accessible label for the chip's remove button. */
  removeLabel(title: string): string;
}

export const RELATION_DIRECTIONS: readonly RelationDirection[] = [
  {
    id: "prerequisites",
    label: "Runs after",
    idsFor: (taskId, tasks) =>
      tasks.find((t) => t.id === taskId)?.dependencies ?? [],
    edge: (taskId, otherId) => ({ id: taskId, depId: otherId }),
    removeLabel: (title) => `Remove dependency ${title}`,
  },
  {
    id: "dependents",
    label: "Blocks",
    idsFor: (taskId, tasks) =>
      TaskGraph.from(tasks)
        .directDependents(taskId)
        .map((t) => t.id),
    edge: (taskId, otherId) => ({ id: otherId, depId: taskId }),
    removeLabel: (title) => `Remove dependent ${title}`,
  },
];

/** A related task as a removable, clickable chip. */
export function RelationChip({
  taskId,
  otherId,
  direction,
  tasks,
}: {
  taskId: string;
  otherId: string;
  direction: RelationDirection;
  tasks: readonly TaskListItem[];
}) {
  const other = tasks.find((t) => t.id === otherId) ?? null;
  const title = other?.title ?? otherId;
  const isTerminal = other ? isSettled(other.status) : false;
  const openPane = useOpenPane();

  const remove = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await fetchEndpoint(removeTaskDependency, direction.edge(taskId, otherId));
  };

  return (
    <li>
      <Row
        bordered
        size="sm"
        actionsAlwaysVisible
        className={
          isTerminal ? "text-muted-foreground line-through" : undefined
        }
        actions={
          <ControlSizeProvider size="sm">
            <IconButton
              icon={closeIcon}
              label={direction.removeLabel(title)}
              variant="ghost"
              onClick={remove}
              className="hover:text-destructive"
            />
          </ControlSizeProvider>
        }
      >
        <button
          type="button"
          {...openPane.link(
            taskDetailPane,
            { taskId: otherId },
            { mode: "swap" },
          )}
          className="max-w-[24ch] truncate text-left"
          title={title}
        >
          {title}
        </button>
      </Row>
    </li>
  );
}

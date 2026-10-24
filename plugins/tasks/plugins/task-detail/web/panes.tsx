import { useCallback, type ReactElement } from "react";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  Pane,
  PaneChrome,
  useOpenPane,
  resolveFrom,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { TasksListView } from "@plugins/tasks/plugins/task-list/web";
import {
  taskRows,
  tasksRootRoute,
  taskDetailRoute,
  type TaskListItem,
} from "@plugins/tasks/plugins/tasks-core/core";
import { useTask } from "@plugins/tasks/web";
import { FileLinksWorkspaceProvider } from "@plugins/primitives/plugins/file-links/web";
import { TaskDetailFlushProvider } from "./context";
import { TaskDetail } from "./components/task-detail";

// Panes are declared first so their types are known before the component
// bodies reference them. Component identifiers below are function
// declarations (hoisted), so the forward reference is safe at runtime.

export const tasksRootPane = Pane.define({
  title: "Tasks",
  route: tasksRootRoute,
  app: agentManagerApp,
  component: TasksRoot,
  width: 320,
});

function useResolveTask({ taskId }: { taskId: string }): ResolveResult {
  // A `select` of the one fact the route needs, so the pane re-resolves when
  // the task appears or goes — not on every push to the task set.
  const select = useCallback(
    (tasks: TaskListItem[]) => tasks.some((t) => t.id === taskId),
    [taskId],
  );
  return resolveFrom(useLive(taskRows, { select }), (exists) => exists);
}

/** The task's title from the global live-state resource, or undefined. */
function useTaskTitle({ taskId }: { taskId: string }): string | undefined {
  // No title until the task is known; a failed read leaves the tab untitled
  // (the pane's sections render that failure).
  return foldResource(useTask(taskId), {
    loading: () => undefined,
    error: () => undefined,
    ready: (task) => task?.title,
  });
}

export const taskDetailPane = Pane.define({
  route: taskDetailRoute,
  app: agentManagerApp,
  component: TaskDetailBody,
  width: 480,
  useResolve: useResolveTask,
  // The task's title: tab, document and header title alike.
  title: { useText: useTaskTitle },
  // Main surface: a conversation or aux pane opened under the task is a
  // drill-in — it never steals the tab title from the task.
  titleOwner: true,
});

function TasksRoot(): ReactElement {
  const openPane = useOpenPane();
  const selectedId = taskDetailPane.useRouteEntry()?.params.taskId;

  return (
    <PaneChrome pane={tasksRootPane}>
      {/* This box OPENS the region — it is not a padded box with a marker on it.
          The `Inset` that used to be here is gone on purpose, and putting it
          back is the mistake to avoid: `Inset` pads without publishing, so an
          `Inset` carrying a rail class would tell its descendants a rail that
          disagrees with the padding it actually applied. `rail-lg` pads AND
          publishes in one declaration, which is why the two are fused into one
          utility. Same step, same all-sides padding as the old `Inset pad="lg"`,
          so the vertical rhythm is unchanged. */}
      <div className="rail-lg">
        <TasksListView
          selectedId={selectedId}
          linkTo={(id) =>
            openPane.to(taskDetailPane, { taskId: id }, { mode: "push" })
          }
        />
      </div>
    </PaneChrome>
  );
}

// One mode everywhere: the pane always shows the detail of the task named in
// the route. Task-to-task navigation is the sections' job (deps tree, graph),
// which re-root this pane by swapping its own route param.
function TaskDetailBody(): ReactElement {
  const { taskId } = taskDetailPane.useParams();

  return (
    <TaskDetailFlushProvider key={taskId}>
      {/* A task is about the repo as it is on main: paths in its description
          and sections name main's checkout. */}
      <FileLinksWorkspaceProvider workspace="main">
        <PaneChrome pane={taskDetailPane}>
          <TaskDetail taskId={taskId} />
        </PaneChrome>
      </FileLinksWorkspaceProvider>
    </TaskDetailFlushProvider>
  );
}

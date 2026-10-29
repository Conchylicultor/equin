import { useMemo, type ReactElement } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  combineResources,
  foldResource,
} from "@plugins/primitives/plugins/live-state/web";
import {
  DataView,
  defineDataView,
  fieldOverrides,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  HostedToolbar,
  HostedToolbarParts,
} from "@plugins/primitives/plugins/data-view/core";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  TASK_STATUS_OPTIONS,
  TaskStatusSchema,
  type TaskListItem,
} from "@plugins/tasks/plugins/tasks-core/core";
import { useTasksById } from "@plugins/tasks/web";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";
import { automationTasks, type AutomationTaskRow } from "../../core";
import { Automations } from "../internal/slots";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const HISTORY_VIEW = defineDataView("tasks.automations.history");

// The collection's ceiling: one automation's history, newest first. Older
// filings past it are said to exist (below the list), never silently dropped.
const HISTORY_LIMIT = 200;

const NO_ROWS: AutomationTaskRow[] = [];

const NO_TASKS: ReadonlyMap<string, TaskListItem> = new Map();

const STATUS_OPTIONS = TaskStatusSchema.options.map((status) => ({
  value: status,
  ...TASK_STATUS_OPTIONS[status],
}));

// The rows are the origin collection's (`automationTasks`: one per task the
// automation filed or started); its one listed column, the automation itself,
// is the scope this list is already narrowed by — a dimension of nothing here.
const HISTORY_OVERRIDES = fieldOverrides(automationTasks, {
  automationId: { visible: false },
});

// The heading IS the list's header, in the same eyebrow the settings panel's
// sections wear above it: one automation's tasks are few, so a toolbar band of
// its own would be a strip that does nothing. The options trigger (search,
// filter, sort) sits beside the heading.
function HistoryFrame({ options, body }: HostedToolbarParts): ReactElement {
  return (
    <Stack gap="xs">
      <Stack direction="row" gap="sm" align="center">
        <Fill>
          <Text as="h3" variant="eyebrow" tone="muted">
            History
          </Text>
        </Fill>
        {options}
      </Stack>
      {body}
    </Stack>
  );
}

const HISTORY_TOOLBAR: HostedToolbar = { kind: "hosted", frame: HistoryFrame };

/**
 * The tasks this automation filed or started, newest first, each with its
 * task's title and status. Activating a row opens the task.
 */
export function AutomationHistory({
  automationId,
}: {
  automationId: string;
}): ReactElement {
  const openPane = useOpenPane();
  const filings = useLive(automationTasks, {
    where: { automationId },
    limit: HISTORY_LIMIT,
  });
  const ids = useMemo(
    () =>
      foldResource(filings, {
        loading: () => [],
        error: () => [],
        unavailable: () => [],
        ready: (rows) => rows.map((r) => r.taskId),
      }),
    [filings],
  );
  const tasks = useTasksById(ids);
  const result = useMemo(
    () => combineResources({ filings, tasks }),
    [filings, tasks],
  );
  const rows = useMemo(
    () =>
      foldResource(result, {
        loading: () => NO_ROWS,
        error: () => NO_ROWS,
        unavailable: () => NO_ROWS,
        ready: (d) => d.filings,
      }),
    [result],
  );
  // A task deleted since its filing is absent from the map: its origin row goes
  // with it, so that lasts only until the delete is pushed.
  const taskById = useMemo(
    () =>
      foldResource(tasks, {
        loading: () => NO_TASKS,
        error: () => NO_TASKS,
        ready: (byId) => byId,
      }),
    [tasks],
  );
  const truncated = filings.status === "ready" && filings.canGrow;

  // The fields the history computes itself, from the task each filing made;
  // the filing's own are the collection's.
  const extraFields = useMemo<FieldDef<AutomationTaskRow>[]>(
    () => [
      {
        id: "title",
        label: "Task",
        type: "text",
        primary: true,
        value: (r) => taskById.get(r.taskId)?.title ?? "",
      },
      {
        id: "status",
        label: "Status",
        type: "enum",
        value: (r) => taskById.get(r.taskId)?.status ?? null,
        options: STATUS_OPTIONS,
        filterable: true,
        groupable: true,
      },
      {
        id: "filedAt",
        label: "Filed or started",
        type: "date",
        value: (r) => new Date(r.filedAt),
        sortable: true,
      },
    ],
    [taskById],
  );

  // Expanding a row shows what the contributing plugins say about its task.
  const viewOptions = useMemo(
    () => ({
      list: {
        detail: (r: AutomationTaskRow) => (
          <TaskDetail taskId={r.taskId} automationId={automationId} />
        ),
      },
    }),
    [automationId],
  );

  return (
    <Stack gap="xs">
      <DataView<AutomationTaskRow>
        rows={rows}
        collection={automationTasks}
        overrides={HISTORY_OVERRIDES}
        extraFields={extraFields}
        rowKey={(r) => r.taskId}
        views={["list"]}
        storageKey={HISTORY_VIEW}
        readiness={result}
        toolbar={HISTORY_TOOLBAR}
        rowActivation={(r) =>
          openPane.to(taskDetailPane, { taskId: r.taskId }, { mode: "push" })
        }
        searchAccessor={(r) => taskById.get(r.taskId)?.title ?? ""}
        searchPlaceholder="Search its tasks…"
        recipe="timeline"
        viewOptions={viewOptions}
        emptyState={<>It has not filed or started a task yet.</>}
      />
      {truncated ? (
        <Text variant="caption" tone="muted">
          Showing the latest {HISTORY_LIMIT} tasks it filed or started.
        </Text>
      ) : null}
    </Stack>
  );
}

/** What the plugins contributing to `Automations.TaskDetail` say about one
 * task — an expanded History row. */
function TaskDetail({
  taskId,
  automationId,
}: {
  taskId: string;
  automationId: string;
}): ReactElement {
  return (
    <Automations.TaskDetail.Render>
      {(contribution) => (
        <contribution.component taskId={taskId} automationId={automationId} />
      )}
    </Automations.TaskDetail.Render>
  );
}

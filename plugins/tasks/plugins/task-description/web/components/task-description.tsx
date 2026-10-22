import { useCallback } from "react";
import { useEditableField } from "@plugins/primitives/plugins/editable-field/web";
import {
  ResourceView,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import { mapRow, useLiveRow } from "@plugins/network/plugins/live/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { LaunchControl } from "@plugins/primitives/plugins/launch/web";
import { patchTask, useTask } from "@plugins/tasks/web";
import { getTask as getTaskEndpoint } from "@plugins/tasks/core";
import {
  taskDescriptions,
  type TaskListItem,
} from "@plugins/tasks/plugins/tasks-core/core";
import { buildTaskPrompt } from "@plugins/tasks/plugins/tasks-core/core";
import {
  useFlushAll,
  useRegisterFlush,
} from "@plugins/tasks/plugins/task-detail/web";
import { DescriptionView } from "./description-view";
import { LaunchOptions } from "./launch-options";

function TaskDescriptionInner({
  taskId,
  task,
  description,
}: {
  taskId: string;
  task: TaskListItem;
  description: string | null;
}) {
  const flushAll = useFlushAll();
  const fetchEndpoint = useFetchEndpoint();

  const descField = useEditableField({
    value: description ?? "",
    onSave: (v) => patchTask(fetchEndpoint, taskId, { description: v }),
  });
  useRegisterFlush(descField.flush);

  const buildLaunchRequest = useCallback(async () => {
    await flushAll();
    /* eslint-disable promise-safety/no-absorbed-failure -- best-effort fresh-task refetch before launch; null falls back to the live row and its live description (`fresh ?? { ...task, description }`), a deliberate stale-but-present degradation, not a lost result */
    const fresh = await fetchEndpoint(getTaskEndpoint, { id: taskId }).catch(
      () => null,
    );
    /* eslint-enable promise-safety/no-absorbed-failure */
    return {
      taskId,
      prompt: buildTaskPrompt(fresh ?? { ...task, description }),
    };
  }, [taskId, task, description, flushAll, fetchEndpoint]);

  return (
    <Stack gap="md">
      <DescriptionView
        value={descField.value}
        onChange={descField.onChange}
        onFocus={descField.onFocus}
        onBlur={descField.onBlur}
      />
      <LaunchOptions taskId={taskId} />
      <Stack align="end" gap="none">
        <LaunchControl
          getRequest={buildLaunchRequest}
          disabled={!task.title.trim()}
          className="w-auto"
          openAfterLaunch={false}
        />
      </Stack>
    </Stack>
  );
}

export function TaskDescription({ taskId }: { taskId: string }) {
  const task = useTask(taskId);
  // `description` is not in the lean `tasks` set — read it by id from
  // `taskDescriptions`, which stays live across tabs (an autosave elsewhere is
  // that one row's refill). A task the read does not find has none.
  const description = mapRow(
    useLiveRow(taskDescriptions, taskId),
    (row) => row?.description ?? null,
  );

  const all = useCombinedResources({ task, description });

  // Wait for the description before showing the editor: seeding
  // useEditableField from a not-yet-loaded "" and letting the user type would
  // race the real value in.
  return (
    <ResourceView resource={all}>
      {({ task: row, description: text }) =>
        row === null ? null : (
          <TaskDescriptionInner taskId={taskId} task={row} description={text} />
        )
      }
    </ResourceView>
  );
}

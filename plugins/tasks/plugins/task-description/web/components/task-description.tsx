import { useCallback } from "react";
import { useEditableField } from "@plugins/primitives/plugins/editable-field/web";
import {
  ResourceView,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import { mapRow, useLiveRow } from "@plugins/network/plugins/live/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { LaunchControl } from "@plugins/primitives/plugins/launch/web";
import { usePatchTask, useTask } from "@plugins/tasks/web";
import {
  taskDescriptions,
  type TaskListItem,
} from "@plugins/tasks/plugins/tasks-core/core";
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

  // Launch builds the agent's prompt from the task AS SAVED on the server, so
  // `flushAll` below must not return before a pending save has landed: the
  // field settles on the save's answer.
  const patchTask = usePatchTask();

  const descField = useEditableField({
    value: description ?? "",
    onSave: (v) => patchTask(taskId, { description: v }),
  });
  useRegisterFlush(descField.flush);

  // Every pending edit is saved first; the server then builds the prompt from
  // the task as saved (`{ from: "task" }`), so the launch carries what was typed.
  const buildLaunchRequest = useCallback(async () => {
    await flushAll();
    return { taskId, prompt: { from: "task" as const } };
  }, [taskId, flushAll]);

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

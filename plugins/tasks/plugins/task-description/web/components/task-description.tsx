import { useCallback, useRef } from "react";
import { useEditableField } from "@plugins/primitives/plugins/editable-field/web";
import {
  ResourceView,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import {
  mapRow,
  useLiveMutation,
  useLiveRow,
} from "@plugins/network/plugins/live/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { LaunchControl } from "@plugins/primitives/plugins/launch/web";
import { updateTask } from "@plugins/tasks/core";
import { useTask } from "@plugins/tasks/web";
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

  // The description shows at once (a predicted write), but Launch builds the
  // agent's prompt from the task AS SAVED on the server, and `flushAll` below
  // must not return before that: a save settles on the server's answer, so
  // the launch request cannot overtake it.
  const settles = useRef(
    new Map<object, { ok: () => void; fail: (err: unknown) => void }>(),
  );
  const update = useLiveMutation(updateTask, {
    onSuccess: (_response, req) => {
      settles.current.get(req)?.ok();
      settles.current.delete(req);
    },
    onError: (err, req, { rejected }) => {
      // A transient failure is retried: the save stays pending until it lands.
      if (!rejected) return;
      settles.current.get(req)?.fail(err);
      settles.current.delete(req);
    },
  });

  const descField = useEditableField({
    value: description ?? "",
    onSave: (v) =>
      new Promise<void>((ok, fail) => {
        const req = { params: { id: taskId }, body: { description: v } };
        settles.current.set(req, { ok, fail });
        update.mutate(req);
      }),
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

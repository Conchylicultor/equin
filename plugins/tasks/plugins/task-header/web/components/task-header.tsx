import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useEditableField } from "@plugins/primitives/plugins/editable-field/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { patchTask, useTask } from "@plugins/tasks/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useRegisterFlush } from "@plugins/tasks/plugins/task-detail/web";
import { StatusSignal } from "@plugins/tasks/plugins/task-status/web";
import { TaskTrackControl } from "@plugins/tasks/plugins/task-track/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { AuthorDisplay } from "./author-display";

export function TaskHeader({ taskId }: { taskId: string }) {
  const result = useTask(taskId);
  const fetchEndpoint = useFetchEndpoint();
  const titleField = useEditableField({
    // The field renders only once the task is known, so the "" seed for the
    // other states is never shown or saved.
    value: foldResource(result, {
      loading: () => "",
      error: () => "",
      ready: (t) => t?.title ?? "",
    }),
    onSave: (v) =>
      patchTask(fetchEndpoint, taskId, { title: v.trim() || "Untitled" }),
    label: "Task title",
  });
  useRegisterFlush(titleField.flush);

  if (result.status === "loading") return null;
  if (result.status === "error")
    return (
      <ResourceErrorInline
        variant="block"
        subject="the task"
        error={result.error}
        refetch={result.refetch}
      />
    );
  const task = result.data;
  if (task === null) return null;

  const toggleDrop = () => {
    void patchTask(fetchEndpoint, taskId, { drop: task.status !== "dropped" });
  };

  const toggleHold = () => {
    void patchTask(fetchEndpoint, taskId, { hold: task.status !== "held" });
  };

  return (
    <Stack gap="lg">
      <input
        value={titleField.value}
        onChange={(e) => titleField.onChange(e.target.value)}
        onFocus={titleField.onFocus}
        onBlur={titleField.onBlur}
        placeholder="Untitled"
        className="text-title w-full bg-transparent outline-none placeholder:text-muted-foreground focus:ring-0"
      />
      <Stack direction="row" align="center" gap="md">
        <SectionLabel as="span">Status</SectionLabel>
        <StatusSignal status={task.status} />
        {/* An empty Fill absorbs the slack, so the buttons sit flush right. */}
        <Fill />
        <Stack direction="row" align="center" gap="xs">
          <Button variant="ghost" onClick={toggleHold}>
            {task.status === "held" ? "Resume" : "Hold"}
          </Button>
          <Button variant="ghost" onClick={toggleDrop}>
            {task.status === "dropped" ? "Undrop" : "Drop task"}
          </Button>
        </Stack>
      </Stack>
      <Stack direction="row" align="center" gap="md">
        <SectionLabel as="span">Track</SectionLabel>
        <TaskTrackControl taskId={taskId} />
      </Stack>
      <Stack direction="row" align="center" gap="md">
        <SectionLabel as="span">Author</SectionLabel>
        <AuthorDisplay author={task.author ?? "user"} />
      </Stack>
      <Stack direction="row" align="center" gap="md">
        <SectionLabel as="span">Created</SectionLabel>
        <Text as="span" variant="caption">
          <RelativeTime date={new Date(task.createdAt)} />
        </Text>
      </Stack>
      {task.finishedAt != null && (
        <Stack direction="row" align="center" gap="md">
          <SectionLabel as="span">Closed</SectionLabel>
          <Text as="span" variant="caption">
            <RelativeTime date={new Date(task.finishedAt)} />
          </Text>
        </Stack>
      )}
    </Stack>
  );
}

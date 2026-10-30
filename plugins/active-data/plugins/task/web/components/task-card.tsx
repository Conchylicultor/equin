import { useLive } from "@plugins/network/plugins/live/web";
import { useId, useRef, useState } from "react";
import { z } from "zod";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { TextEditor } from "@plugins/primitives/plugins/text-editor/web";
import { LaunchControl } from "@plugins/primitives/plugins/launch/web";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";
import { useActiveDataBinding } from "@plugins/active-data/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ConversationRow } from "@plugins/conversations/plugins/conversation-ui/plugins/row/web";
import { taskRows } from "@plugins/tasks/plugins/tasks-core/core";
import { useTaskAttempts } from "@plugins/tasks/plugins/tasks-core/web";
import { createTask as createTaskEndpoint } from "@plugins/tasks/core";
import { AttemptStatusBadge } from "@plugins/tasks/plugins/attempt-status/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";

const TaskBindingSchema = z.object({
  taskId: z.string(),
  launchedConvId: z.string().optional(),
});
type TaskBinding = z.infer<typeof TaskBindingSchema>;

export function TaskCard({
  content,
}: {
  attrs: Record<string, string>;
  content: string;
}) {
  const fetchEndpoint = useFetchEndpoint();
  const initial = content.trim();
  const editorNs = useId();
  const { convId } = conversationPane.useParams();
  const conversation = useConversationById(convId);
  const hostTaskId = conversation?.taskId ?? null;

  const binding = useActiveDataBinding<TaskBinding>(TaskBindingSchema);

  const [prompt, setPrompt] = useState(initial);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Captured in a ref (not state) because onLaunched closes over the render
  // it was created in — a state setter from getRequest wouldn't be visible
  // to the in-flight callback. The ref always reads the latest value.
  const pendingTaskIdRef = useRef<string | null>(null);

  if (!initial) return null;

  // Wait for the binding to load before rendering anything destructive — the
  // editable card collapses to a chip once we know the persisted state, so
  // showing the card during load would briefly invite a duplicate Create.
  // A failed read renders the failure instead: showing the card would invite
  // the same duplicate Create.
  if (binding.enabled) {
    if (binding.value.status === "loading") return null;
    if (binding.value.status === "error") {
      return (
        <ResourceErrorInline
          variant="inline"
          subject="this task card"
          error={binding.value.error}
          refetch={binding.value.refetch}
        />
      );
    }
  }
  // Not enabled ⇒ no identity, so nothing is persisted: the editable card.
  const value = foldResource(binding.value, {
    loading: () => null,
    error: () => null,
    ready: (v) => v,
  });

  if (value?.launchedConvId && value.taskId) {
    return (
      <Stack
        gap="xs"
        // eslint-disable-next-line spacing/no-adhoc-spacing -- top-level widget vertical offset in markdown transcript flow
        className="my-2"
      >
        <Text as="p" variant="body" tone="muted">
          {initial}
        </Text>
        <LaunchedAttempts taskId={value.taskId} />
      </Stack>
    );
  }

  if (value?.taskId) {
    return <TaskChip taskId={value.taskId} />;
  }

  const trimmed = prompt.trim();
  const disabled = creating || !trimmed;

  const createTask = async () => {
    return fetchEndpoint(
      createTaskEndpoint,
      {},
      { body: { folderId: hostTaskId, description: trimmed } },
    );
  };

  const onCreate = async () => {
    if (creating || !trimmed) return;
    setCreating(true);
    setError(null);
    try {
      const task = await createTask();
      await binding.set({ taskId: task.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Stack
      as={Card}
      gap="sm"
      // eslint-disable-next-line spacing/no-adhoc-spacing -- top-level widget vertical offset in markdown transcript flow
      className="bg-background my-2 p-sm"
    >
      <TextEditor
        value={prompt}
        onChange={setPrompt}
        placeholder="What should be done?"
        disabled={creating}
        minRows={3}
        maxHeight="20rem"
        namespace={`active-data-task-${editorNs}`}
      />
      <Stack direction="row" align="center" justify="end" gap="sm">
        {error ? (
          <Text
            as="span"
            variant="caption"
            tone="destructive"
            className="mr-auto truncate"
            title={error}
          >
            {error}
          </Text>
        ) : null}
        <Button
          variant="ghost"
          onClick={onCreate}
          disabled={disabled}
          tooltip="Create task"
        >
          {creating ? "Creating…" : "Create"}
        </Button>
        <LaunchControl
          size="icon"
          disabled={disabled}
          openAfterLaunch={false}
          getRequest={async () => {
            const task = await createTask();
            pendingTaskIdRef.current = task.id;
            await binding.set({ taskId: task.id });
            return { taskId: task.id, prompt: trimmed };
          }}
          onLaunched={async (conv) => {
            const taskId = pendingTaskIdRef.current;
            if (taskId) {
              await binding.set({ taskId, launchedConvId: conv.id });
            }
          }}
        />
      </Stack>
    </Stack>
  );
}

function LaunchedAttempts({ taskId }: { taskId: string }) {
  const attempts = useTaskAttempts(taskId);

  if (attempts.status === "loading") return <Loading variant="text" />;
  if (attempts.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the attempts"
        error={attempts.error}
        refetch={attempts.refetch}
      />
    );
  }

  if (attempts.data.length === 0) {
    return (
      <Text as="span" variant="caption" tone="muted" className="block">
        Launching…
      </Text>
    );
  }

  return (
    <Stack as={Card} gap="sm" className="px-md py-sm bg-transparent">
      {attempts.data.map((attempt) => (
        <Stack key={attempt.id} gap="xs">
          <Stack direction="row" align="center" gap="sm">
            <AttemptStatusBadge status={attempt.status} />
            <Text
              as="span"
              variant="caption"
              tone="muted"
              className="truncate font-mono"
            >
              {attempt.worktreePath.split("/").pop()}
            </Text>
          </Stack>
          {attempt.conversations.length > 0 && (
            <Stack as="ul" gap="2xs">
              {attempt.conversations.map((c) => (
                <li key={c.id}>
                  <ConversationRow conv={c} />
                </li>
              ))}
            </Stack>
          )}
        </Stack>
      ))}
    </Stack>
  );
}

function TaskChip({ taskId }: { taskId: string }) {
  const { convId } = conversationPane.useParams();
  const conversation = useConversationById(convId);
  const tasksResult = useLive(taskRows);
  const openPane = useOpenPane();
  if (!conversation) return null;
  if (tasksResult.status === "loading") return null;
  if (tasksResult.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the task"
        error={tasksResult.error}
        refetch={tasksResult.refetch}
      />
    );
  }
  const task = tasksResult.data.find((t) => t.id === taskId);
  const title = task?.title.trim() || "Untitled task";
  return (
    <LinkChip
      activation={openPane.to(taskDetailPane, { taskId }, { mode: "push" })}
      leading={<span className="text-muted-foreground">✓</span>}
      tooltip={title}
    >
      {title}
    </LinkChip>
  );
}

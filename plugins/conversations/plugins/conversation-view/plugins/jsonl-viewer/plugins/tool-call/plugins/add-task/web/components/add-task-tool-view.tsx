import { useLive } from "@plugins/network/plugins/live/web";
import { useMemo } from "react";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";
import { taskRows } from "@plugins/tasks/plugins/tasks-core/core";
import { StatusIcon } from "@plugins/tasks/plugins/task-status/web";
import {
  DEFAULT_TASK_TRACK,
  TRACK_META,
  type TaskTrack,
} from "@plugins/tasks/plugins/task-track/core";
import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { modelDisplayLabel } from "@plugins/conversations/plugins/model-provider/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";

type AddTaskInput = {
  title: string;
  description?: string;
  /** Absent on calls made before tracks existed — those tasks are main-track. */
  track?: TaskTrack;
  relation?: "followup" | "prerequisite" | "independent";
  target?: string;
  autostart: string | null;
};

type AddTaskResult = {
  task_id: string;
  relation: string;
  group_id?: string | null;
  autostart: string | null;
};

function parseResult(event: ToolRendererProps["event"]): AddTaskResult | null {
  if (!event.result?.content) return null;
  try {
    return JSON.parse(event.result.content);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
}

export function AddTaskToolView({ event }: ToolRendererProps) {
  const input = event.input as AddTaskInput;
  const result = parseResult(event);
  const taskId = result?.task_id;
  const autostart = input.autostart ?? result?.autostart ?? null;
  const track = TRACK_META[input.track ?? DEFAULT_TASK_TRACK];

  const tasksResult = useLive(taskRows);
  const openPane = useOpenPane();
  // Loading shows the bare task id (known from the call, never revised); a
  // failed read keeps the task as last seen, else the same bare id.
  const task = useMemo(() => {
    const tasks = foldResource(tasksResult, {
      loading: () => null,
      error: (_error, stale) => stale ?? null,
      ready: (data) => data,
    });
    if (tasks === null || !taskId) return null;
    return tasks.find((t) => t.id === taskId) ?? null;
  }, [tasksResult, taskId]);

  const summary = (
    <Stack as="span" direction="row" align="center" gap="sm">
      <Text as="span">{input.title}</Text>
      <Badge variant="muted" className={rigidClass()} title={track.hint}>
        {track.label}
      </Badge>
      {autostart ? (
        <Badge variant="success" className={rigidClass()}>
          auto-launch {modelDisplayLabel(autostart)}
        </Badge>
      ) : (
        <Badge variant="warning" className={rigidClass()}>
          no auto-launch
        </Badge>
      )}
    </Stack>
  );

  return (
    <ToolCallCard event={event} summary={summary} defaultOpen>
      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- mt-2 offsets the body from the ToolCallCard header inside its collapsible region; not a Stack-owned gap */}
      <Stack gap="sm" className="mt-2">
        {input.description && (
          <Text
            as="p"
            variant="caption"
            className="text-muted-foreground whitespace-pre-wrap"
          >
            {input.description}
          </Text>
        )}
        {taskId && (
          <LinkChip
            activation={openPane.to(
              taskDetailPane,
              { taskId },
              { mode: "push" },
            )}
            leading={task ? <StatusIcon status={task.status} /> : undefined}
            title={task ? `${task.title} · ${taskId}` : taskId}
          >
            {task?.title ?? <span className="font-mono">{taskId}</span>}
          </LinkChip>
        )}
        {event.result?.isError && (
          <Text as="p" variant="caption" className="text-destructive">
            {event.result.content}
          </Text>
        )}
      </Stack>
    </ToolCallCard>
  );
}

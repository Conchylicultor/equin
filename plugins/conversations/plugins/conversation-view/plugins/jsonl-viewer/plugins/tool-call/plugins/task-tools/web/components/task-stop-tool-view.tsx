import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import type { TaskRefInput } from "../../core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

export function TaskStopToolView({
  event,
  input,
}: ToolViewProps<TaskRefInput>) {
  const taskId = input.taskId ?? input.id;

  const summary = taskId ? (
    <span className="font-mono text-2xs">{taskId}</span>
  ) : undefined;

  return (
    <ToolCallCard event={event} summary={summary} defaultOpen={false}>
      {event.result?.isError && (
        <Text as="p" variant="caption" className="text-destructive">
          {event.result.content}
        </Text>
      )}
    </ToolCallCard>
  );
}

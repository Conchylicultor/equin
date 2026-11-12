import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import type { TaskRefInput } from "../../core";
import {
  ToolCallCard,
  ToolOutput,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";

export function TaskOutputToolView({
  event,
  input,
}: ToolViewProps<TaskRefInput>) {
  const taskId = input.taskId ?? input.id;

  const summary = taskId ? (
    <span className="font-mono text-2xs">{taskId}</span>
  ) : undefined;

  return (
    <ToolCallCard event={event} summary={summary} defaultOpen={false}>
      <ToolOutput event={event} />
    </ToolCallCard>
  );
}

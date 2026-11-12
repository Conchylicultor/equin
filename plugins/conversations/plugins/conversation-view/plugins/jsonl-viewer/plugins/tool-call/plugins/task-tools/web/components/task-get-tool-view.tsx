import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import {
  ToolCallCard,
  ToolOutput,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";

type TaskGetInput = {
  taskId?: string;
  id?: string;
};

export function TaskGetToolView({ event }: ToolRendererProps) {
  const input = event.input as TaskGetInput;
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

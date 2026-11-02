import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";

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
      {event.result && !event.result.isError && (
        <Scroll
          as="pre"
          axis="both"
          className="max-h-[200px] rounded-md bg-muted/50 p-sm text-2xs text-muted-foreground"
        >
          {event.result.content}
        </Scroll>
      )}
      {event.result?.isError && (
        <Text as="p" variant="caption" tone="destructive">
          {event.result.content}
        </Text>
      )}
    </ToolCallCard>
  );
}

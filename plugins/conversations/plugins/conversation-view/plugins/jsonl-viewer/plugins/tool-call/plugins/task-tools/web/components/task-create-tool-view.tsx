import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import type { TaskCreateInput } from "../../core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

export function TaskCreateToolView({
  event,
  input,
}: ToolViewProps<TaskCreateInput>) {
  const summary = (
    <span className="truncate">
      {input.subject ?? input.description ?? "New task"}
    </span>
  );

  return (
    <ToolCallCard event={event} summary={summary} defaultOpen={false}>
      {input.description && input.subject && (
        <Text
          as="p"
          variant="caption"
          className="text-muted-foreground whitespace-pre-wrap"
        >
          {input.description}
        </Text>
      )}
      {event.result?.isError && (
        <Text as="p" variant="caption" className="text-destructive">
          {event.result.content}
        </Text>
      )}
    </ToolCallCard>
  );
}

import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { readManageAnswer } from "@plugins/tasks/core";
import { Refusal, TaskChip } from "./target-chip";

type DropTaskInput = { task_id: string };

export function DropTaskView({ event }: ToolRendererProps) {
  const input = event.input as DropTaskInput;
  const answer = event.result ? readManageAnswer(event.result.content) : null;
  const refused = answer?.kind === "refused";
  return (
    <ToolCallCard
      event={event}
      aside={<TaskChip taskId={input.task_id} />}
      note={refused ? "· refused" : undefined}
      isError={refused || undefined}
      defaultOpen={refused}
    >
      {refused && <Refusal message={answer.message} />}
    </ToolCallCard>
  );
}

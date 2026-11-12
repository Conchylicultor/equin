import { z } from "zod";
import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { readManageAnswer } from "@plugins/tasks/core";
import { Refusal, TaskChip } from "./target-chip";

/** `drop_task`'s input, as its card draws it. */
export const DropTaskInputSchema = z.looseObject({ task_id: z.string() });
type DropTaskInput = z.infer<typeof DropTaskInputSchema>;

export function DropTaskView({ event, input }: ToolViewProps<DropTaskInput>) {
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

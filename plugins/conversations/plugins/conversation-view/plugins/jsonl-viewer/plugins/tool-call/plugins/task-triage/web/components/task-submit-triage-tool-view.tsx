import { z } from "zod";
import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  TRIAGE_PRIORITY_META,
  TRIAGE_RISK_META,
  TRIAGE_TASK_TYPE_META,
  TRIAGE_VERDICT_META,
} from "@plugins/tasks/plugins/task-triage/core";

/**
 * `task_submit_triage`'s input while the model writes it: any field may be
 * missing, and a vocabulary value may stop mid-word (its chip then draws
 * nothing). The finished input is read with the tool's own `TriageResultSchema`.
 */
export const PartialTriageInputSchema = z.looseObject({
  verdict: z.string().optional(),
  priority: z.string().optional(),
  taskType: z.string().optional(),
  risk: z.string().optional(),
  context: z.string().optional(),
  question: z.string().nullable().optional(),
  answers: z.array(z.string()).optional(),
  areas: z.array(z.string()).optional(),
});
type TaskSubmitTriageInput = z.infer<typeof PartialTriageInputSchema>;

/** A chip for a vocabulary value; an unknown (cut) value draws nothing. */
function Chip({
  meta,
  value,
}: {
  meta: Record<string, { label: string; variant?: string; hint?: string }>;
  value: string | undefined;
}) {
  const entry = value === undefined ? undefined : meta[value];
  if (!entry) return null;
  return (
    <Badge
      variant={(entry.variant ?? "muted") as "muted"}
      className={rigidClass()}
      tooltip={entry.hint}
    >
      {entry.label}
    </Badge>
  );
}

export function TaskSubmitTriageToolView({
  event,
  input,
}: ToolViewProps<TaskSubmitTriageInput>) {
  const answers = input.answers ?? [];

  const summary = (
    <Stack as="span" direction="row" align="center" gap="sm">
      <Chip meta={TRIAGE_VERDICT_META} value={input.verdict} />
      <Chip meta={TRIAGE_PRIORITY_META} value={input.priority} />
      <Chip meta={TRIAGE_TASK_TYPE_META} value={input.taskType} />
      <Chip meta={TRIAGE_RISK_META} value={input.risk} />
    </Stack>
  );

  return (
    <ToolCallCard
      event={event}
      summary={summary}
      note={input.areas?.length ? input.areas.join(", ") : undefined}
      defaultOpen
    >
      <Stack gap="sm">
        {input.context && (
          <div className="prose-xs text-caption text-muted-foreground">
            <Markdown>{input.context}</Markdown>
          </div>
        )}
        {input.question && (
          <Stack gap="xs">
            <Text as="p" variant="label">
              {input.question}
            </Text>
            {answers.length > 0 && (
              <Text as="p" variant="caption" tone="muted">
                {answers.join(" · ")}
              </Text>
            )}
          </Stack>
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

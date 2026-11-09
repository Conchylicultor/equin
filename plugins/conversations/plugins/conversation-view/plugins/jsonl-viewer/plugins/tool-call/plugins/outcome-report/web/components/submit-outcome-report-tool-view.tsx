import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

// Partial while the call streams: any field may be missing, a string cut.
type SubmitOutcomeReportInput = {
  body?: string;
  question?: string;
  answers?: string[];
};

/** The report's first line of prose, markdown markers stripped. */
function headline(body: string | undefined): string {
  for (const raw of (body ?? "").split("\n")) {
    const line = raw
      .replace(/^[\s>#*-]+/, "")
      .replace(/\*\*|__|`/g, "")
      .trim();
    if (line !== "") return line;
  }
  return "Outcome report";
}

/**
 * The submitted report is also drawn as a card at the end of the transcript
 * (tasks/outcome-report), so the call's own card stays compact: headline in the
 * header, the full markdown collapsed under it.
 */
export function SubmitOutcomeReportToolView({ event }: ToolRendererProps) {
  const input = event.input as SubmitOutcomeReportInput;
  const answers = input.answers ?? [];

  return (
    <ToolCallCard
      event={event}
      summary={<Text as="span">{headline(input.body)}</Text>}
      note={input.question ? "asks a question" : undefined}
    >
      <Stack gap="sm">
        {input.body && (
          <div className="prose-xs text-caption text-muted-foreground">
            <Markdown>{input.body}</Markdown>
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

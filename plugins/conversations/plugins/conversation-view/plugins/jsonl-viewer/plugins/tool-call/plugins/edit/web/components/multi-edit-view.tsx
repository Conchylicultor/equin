import { z } from "zod";
import type {
  ToolCall,
  ToolViewProps,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import {
  ToolCallCard,
  ToolCode,
  ToolSection,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { FilePath } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { InlineDiff } from "./inline-diff";

/** `MultiEdit`'s input, as its card draws it. */
export const MultiEditInputSchema = z.looseObject({
  file_path: z.string(),
  edits: z.array(
    z.looseObject({ old_string: z.string(), new_string: z.string() }),
  ),
});
type MultiEditInput = z.infer<typeof MultiEditInputSchema>;

function ResultDetail({ result }: { result: ToolCall["result"] }) {
  if (!result || !result.isError) return null;
  return (
    <ToolSection label="Output" copyText={result.content}>
      <ToolCode tone="error">{result.content || "Error"}</ToolCode>
    </ToolSection>
  );
}

export function MultiEditView({ event, input }: ToolViewProps<MultiEditInput>) {
  const { file_path, edits } = input;
  const multi = edits.length > 1;
  return (
    <ToolCallCard
      event={event}
      aside={<FilePath filePath={file_path} />}
      defaultOpen={event.result?.isError === true}
    >
      <Stack gap="md">
        {edits.map((edit, i) => (
          <Stack key={i} gap="xs">
            {multi && (
              <Stack
                direction="row"
                gap="sm"
                align="center"
                className="text-2xs text-muted-foreground"
              >
                <span>
                  Edit {i + 1} / {edits.length}
                </span>
                <Fill as="hr" className="border-border/40" />
              </Stack>
            )}
            <InlineDiff
              oldText={edit.old_string}
              newText={edit.new_string}
              path={file_path}
            />
          </Stack>
        ))}
        <ResultDetail result={event.result} />
      </Stack>
    </ToolCallCard>
  );
}

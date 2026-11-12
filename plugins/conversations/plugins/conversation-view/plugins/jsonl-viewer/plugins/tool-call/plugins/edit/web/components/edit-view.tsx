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
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { InlineDiff } from "./inline-diff";

/** `Edit`'s input, as its card draws it. */
export const EditInputSchema = z.looseObject({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
});

/** What is written of an `Edit`'s input while the model writes it: the diff fills in. */
export const PartialEditInputSchema = EditInputSchema.partial();
type PartialEditInput = z.infer<typeof PartialEditInputSchema>;

function ResultDetail({ result }: { result: ToolCall["result"] }) {
  if (!result || !result.isError) return null;
  return (
    <ToolSection label="Output" copyText={result.content}>
      <ToolCode tone="error">{result.content || "Error"}</ToolCode>
    </ToolSection>
  );
}

export function EditView({ event, input }: ToolViewProps<PartialEditInput>) {
  const { file_path = "", old_string = "", new_string = "" } = input;
  return (
    <ToolCallCard
      event={event}
      aside={<FilePath filePath={file_path} />}
      defaultOpen={event.result?.isError === true}
    >
      <Stack gap="sm">
        <InlineDiff
          oldText={old_string}
          newText={new_string}
          path={file_path}
        />
        <ResultDetail result={event.result} />
      </Stack>
    </ToolCallCard>
  );
}

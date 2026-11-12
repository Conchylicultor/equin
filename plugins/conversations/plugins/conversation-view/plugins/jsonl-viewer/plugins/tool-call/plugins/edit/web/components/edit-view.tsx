import type {
  ToolRendererProps,
  ToolCallEvent,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import {
  ToolCallCard,
  ToolCode,
  ToolSection,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { FilePath } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { InlineDiff } from "./inline-diff";

type EditInput = { file_path: string; old_string: string; new_string: string };

function ResultDetail({ result }: { result: ToolCallEvent["result"] }) {
  if (!result || !result.isError) return null;
  return (
    <ToolSection label="Output" copyText={result.content}>
      <ToolCode tone="error">{result.content || "Error"}</ToolCode>
    </ToolSection>
  );
}

export function EditView({ event }: ToolRendererProps) {
  const {
    file_path = "",
    old_string = "",
    new_string = "",
  } = (event.input ?? {}) as Partial<EditInput>;
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

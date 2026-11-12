import type {
  ToolRendererProps,
  ToolCallEvent,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { FilePath } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { InlineDiff } from "./inline-diff";

type MultiEditInput = {
  file_path: string;
  edits: { old_string: string; new_string: string }[];
};

function ResultDetail({ result }: { result: ToolCallEvent["result"] }) {
  if (!result || !result.isError) return null;
  return (
    <Text
      as="div"
      variant="caption"
      tone="destructive"
      className="rounded-md bg-destructive/10 p-sm whitespace-pre-wrap break-words"
    >
      {result.content || "Error"}
    </Text>
  );
}

export function MultiEditView({ event }: ToolRendererProps) {
  const { file_path = "", edits = [] } = (event.input ??
    {}) as Partial<MultiEditInput>;
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

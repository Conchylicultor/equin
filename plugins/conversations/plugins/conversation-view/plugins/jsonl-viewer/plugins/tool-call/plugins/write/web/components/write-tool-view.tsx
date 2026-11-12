import {
  HighlightedCode,
  languageForPath,
} from "@plugins/primitives/plugins/syntax-highlight/web";
import { z } from "zod";
import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { FilePath } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";

/** Write's input, as its card draws it. */
export const WriteInputSchema = z.looseObject({
  file_path: z.string(),
  content: z.string(),
});

/** What the card draws while the model is still writing the call: any field may be missing yet. */
export const PartialWriteInputSchema = WriteInputSchema.partial();

export function WriteToolView({
  event,
  input,
}: ToolViewProps<z.infer<typeof PartialWriteInputSchema>>) {
  const { file_path = "", content = "" } = input;

  return (
    <ToolCallCard event={event} aside={<FilePath filePath={file_path} />}>
      <Stack gap="xs">
        <Scroll axis="both" className="max-h-[280px]">
          <HighlightedCode code={content} lang={languageForPath(file_path)} />
        </Scroll>
        {event.result?.isError && (
          <Text as="p" variant="caption" className="text-destructive">
            {event.result.content}
          </Text>
        )}
      </Stack>
    </ToolCallCard>
  );
}

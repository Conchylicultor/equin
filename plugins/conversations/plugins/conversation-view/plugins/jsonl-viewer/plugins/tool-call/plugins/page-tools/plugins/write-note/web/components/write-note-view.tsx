import { z } from "zod";
import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { parsePageApplyReport } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/page-tools/core";
import {
  PageMarkdown,
  PageRefChip,
  PageToolError,
  PageWriteReport,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/page-tools/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";

/** `write_agent_note`'s input, as its card draws it. */
export const WriteAgentNoteInputSchema = z.looseObject({
  block_id: z.string(),
  content: z.string(),
});
type WriteAgentNoteInput = z.infer<typeof WriteAgentNoteInputSchema>;

export function WriteNoteView({
  event,
  input: { block_id, content },
}: ToolViewProps<WriteAgentNoteInput>) {
  const report = parsePageApplyReport(event);

  return (
    <ToolCallCard
      event={event}
      // `block_id` names a card, not a page, so it resolves to a page chip only
      // via the report's `page_id` — which exists only once the write returned.
      aside={<PageRefChip pageId={report?.page_id} blockId={block_id} />}
    >
      <Stack gap="sm">
        <PageMarkdown text={content} />
        <PageWriteReport report={report} />
        <PageToolError result={event.result} />
      </Stack>
    </ToolCallCard>
  );
}

import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { parsePageApplyReport } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/page-tools/core";
import {
  PageMarkdown,
  PageRefChip,
  PageToolError,
  PageWriteReport,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/page-tools/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";

type WriteAgentNoteInput = { block_id: string; content: string };

export function WriteNoteView({ event }: ToolRendererProps) {
  const { block_id = "", content = "" } = (event.input ??
    {}) as Partial<WriteAgentNoteInput>;
  const report = parsePageApplyReport(event);

  return (
    <ToolCallCard
      event={event}
      // `block_id` names a card, not a page, so it resolves to a page chip only
      // via the report's `page_id` — which exists only once the write returned.
      aside={<PageRefChip pageId={report?.page_id} blockId={block_id} />}
    >
      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- mt-2 offsets the body from the ToolCallCard header inside its collapsible region; not a Stack-owned gap */}
      <Stack gap="sm" className="mt-2">
        <PageMarkdown text={content} />
        <PageWriteReport report={report} />
        <PageToolError result={event.result} />
      </Stack>
    </ToolCallCard>
  );
}

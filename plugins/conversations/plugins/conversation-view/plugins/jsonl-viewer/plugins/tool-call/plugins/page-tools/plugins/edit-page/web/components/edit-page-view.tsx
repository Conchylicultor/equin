import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { parsePageApplyReport } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/page-tools/core";
import {
  PageRefChip,
  PageToolError,
  PageWriteReport,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/page-tools/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { TextDiff } from "@plugins/primitives/plugins/diff-view/web";

type EditPageInput = {
  block_id: string;
  old_string: string;
  new_string: string;
  replace_all: boolean;
};

export function EditPageView({ event }: ToolRendererProps) {
  const {
    block_id = "",
    old_string = "",
    new_string = "",
    replace_all = false,
  } = (event.input ?? {}) as Partial<EditPageInput>;
  const report = parsePageApplyReport(event);

  const aside = (
    <Inline gap="sm">
      <PageRefChip pageId={report?.page_id} blockId={block_id} />
      {replace_all && <Badge variant="muted">all occurrences</Badge>}
    </Inline>
  );

  return (
    <ToolCallCard event={event} aside={aside} defaultOpen>
      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- mt-2 offsets the body from the ToolCallCard header inside its collapsible region; not a Stack-owned gap */}
      <Stack gap="sm" className="mt-2">
        {/* The two strings are markdown fragments of the page document, so the
            diff is given a .md path to highlight them as such. */}
        <TextDiff oldText={old_string} newText={new_string} path="page.md" />
        <PageWriteReport report={report} />
        <PageToolError result={event.result} />
      </Stack>
    </ToolCallCard>
  );
}

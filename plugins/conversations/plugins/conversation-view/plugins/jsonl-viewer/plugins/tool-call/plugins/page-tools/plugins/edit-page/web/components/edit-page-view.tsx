import { z } from "zod";
import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
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

/** `edit_page`'s input, as its card draws it. */
export const EditPageInputSchema = z.looseObject({
  block_id: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});
type EditPageInput = z.infer<typeof EditPageInputSchema>;

export function EditPageView({
  event,
  input: { block_id, old_string, new_string, replace_all = false },
}: ToolViewProps<EditPageInput>) {
  const report = parsePageApplyReport(event);

  const aside = (
    <Inline gap="sm">
      <PageRefChip pageId={report?.page_id} blockId={block_id} />
      {replace_all && <Badge variant="muted">all occurrences</Badge>}
    </Inline>
  );

  return (
    <ToolCallCard
      event={event}
      aside={aside}
      defaultOpen={event.result?.isError === true}
    >
      <Stack gap="sm">
        {/* The two strings are markdown fragments of the page document, so the
            diff is given a .md path to highlight them as such. */}
        <TextDiff oldText={old_string} newText={new_string} path="page.md" />
        <PageWriteReport report={report} />
        <PageToolError result={event.result} />
      </Stack>
    </ToolCallCard>
  );
}

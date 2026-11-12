import { z } from "zod";
import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import {
  PageMarkdown,
  PageRefChip,
  PageToolError,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/page-tools/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";

/**
 * `read_page`'s input, as its card draws it: the block the read was scoped to.
 * `block_id` was `blockId` in an earlier revision of this tool; old transcripts
 * carry that spelling.
 */
export const ReadPageInputSchema = z.union([
  z
    .looseObject({ block_id: z.string() })
    .transform((input) => ({ blockId: input.block_id })),
  z
    .looseObject({ blockId: z.string() })
    .transform((input) => ({ blockId: input.blockId })),
]);
type ReadPageInput = z.infer<typeof ReadPageInputSchema>;

export function ReadPageView({
  event,
  input: { blockId },
}: ToolViewProps<ReadPageInput>) {

  return (
    <ToolCallCard event={event} aside={<PageRefChip blockId={blockId} />}>
      <Stack gap="sm">
        {event.result && !event.result.isError && (
          <PageMarkdown text={event.result.content} />
        )}
        <PageToolError result={event.result} />
      </Stack>
    </ToolCallCard>
  );
}

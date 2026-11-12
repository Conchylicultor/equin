import { RowView } from "@plugins/network/plugins/live/web";
import { z } from "zod";
import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { FilePath } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { CatNListing } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/code-listing/web";
import { ReadImageView } from "./read-image-view";

/** The Read tool's input, as its card draws it. */
export const ReadInputSchema = z.looseObject({
  file_path: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
});
type ReadInput = z.infer<typeof ReadInputSchema>;

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "ico",
  "bmp",
  "avif",
]);

function isImagePath(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTS.has(filePath.slice(dot + 1).toLowerCase());
}

function LineRangeBadge({
  offset,
  limit,
}: {
  offset?: number;
  limit?: number;
}) {
  if (offset == null && limit == null) return null;
  const start = (offset ?? 0) + 1;
  const end = limit != null ? start + limit - 1 : null;
  const label = end != null ? `L${start}–${end}` : `L${start}+`;
  return (
    <Badge variant="muted" className="font-mono">
      {label}
    </Badge>
  );
}

export function ReadToolView({
  event,
  input: { file_path, offset, limit },
}: ToolViewProps<ReadInput>) {
  const { convId } = conversationPane.useParams();
  // Only the picture needs the conversation (its worktree): the card itself
  // draws from the event, so it never vanishes while that read is pending.
  const conversation = useConversationById(convId);

  const aside = (
    <Line as="span" className="gap-sm">
      <FilePath filePath={file_path} />
      <LineRangeBadge offset={offset} limit={limit} />
    </Line>
  );

  const isImage = isImagePath(file_path);

  return (
    <ToolCallCard event={event} aside={aside} defaultOpen={isImage}>
      {event.result && (
        <>
          {event.result.isError ? (
            <Text as="p" variant="caption" className="text-destructive">
              {event.result.content}
            </Text>
          ) : isImagePath(file_path) ? (
            <RowView
              row={conversation}
              subject="the conversation"
              missing={
                <Text as="p" variant="caption" className="text-destructive">
                  Conversation not found: cannot locate {file_path}
                </Text>
              }
            >
              {(row) => (
                <ReadImageView
                  worktree={row.attemptId}
                  worktreePath={row.worktreePath}
                  filePath={file_path}
                  size={event.result?.imageSize}
                />
              )}
            </RowView>
          ) : (
            <CatNListing content={event.result.content} filePath={file_path} />
          )}
        </>
      )}
    </ToolCallCard>
  );
}

import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { FilePath } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { CatNListing } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/code-listing/web";
import { ReadImageView } from "./read-image-view";

type ReadInput = { file_path: string; offset?: number; limit?: number };

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

export function ReadToolView({ event }: ToolRendererProps) {
  const {
    file_path = "",
    offset,
    limit,
  } = (event.input ?? {}) as Partial<ReadInput>;
  const { convId } = conversationPane.useParams();
  const conversation = useConversationById(convId);

  if (!conversation) return null;

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
        // eslint-disable-next-line spacing/no-adhoc-spacing -- mt-2 offsets the result block from the card header
        <div className="mt-2">
          {event.result.isError ? (
            <Text as="p" variant="caption" className="text-destructive">
              {event.result.content}
            </Text>
          ) : isImagePath(file_path) ? (
            <ReadImageView
              worktree={conversation.attemptId}
              worktreePath={conversation.worktreePath}
              filePath={file_path}
              size={event.result.imageSize}
            />
          ) : (
            <CatNListing content={event.result.content} filePath={file_path} />
          )}
        </div>
      )}
    </ToolCallCard>
  );
}

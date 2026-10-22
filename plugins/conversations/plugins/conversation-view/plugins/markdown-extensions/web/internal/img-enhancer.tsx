import { useMemo, type ReactNode } from "react";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import {
  AssetThumbnail,
  ViewerThumbnail,
} from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import {
  attachmentUrl,
  isAttachmentUrl,
} from "@plugins/primitives/plugins/text-editor/plugins/paste-images/web";
import {
  MarkdownEnhancementContext,
  useMarkdownEnhancement,
  type MarkdownEnhancement,
} from "@plugins/primitives/plugins/markdown/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { filePeekPane } from "@plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";
import {
  fileRefForPath,
  fileUrl,
} from "@plugins/primitives/plugins/file-viewer/core";

const IMG_HREF_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)(?:[?#].*)?$/i;

function isExternalUrl(src: string): boolean {
  return (
    src.startsWith("http://") ||
    src.startsWith("https://") ||
    src.startsWith("data:")
  );
}

/** The file name a markdown image's address ends in — `IMG_HREF_RE` has
 *  already required an image extension there. */
function basename(src: string): string {
  const path = src.replace(/[?#].*$/, "");
  return path.slice(path.lastIndexOf("/") + 1);
}

export function ImgEnhancer({ children }: { children: ReactNode }) {
  const convId = conversationPane.useRouteEntry()?.params.convId ?? null;
  const conversation = useConversationById(convId);
  const taskEntry = taskDetailPane.useRouteEntry();
  const openPane = useOpenPane();
  const worktree = conversation?.attemptId ?? (taskEntry ? "main" : undefined);
  // Known only for a conversation's worktree: an absolute path inside it reads
  // from git; any other absolute or `~` path reads from the host.
  const worktreePath = conversation?.worktreePath;

  const fileTarget = useMemo(() => {
    if (!worktree) return undefined;
    return (path: string) =>
      openPane.to(filePeekPane, { worktree, filePath: path }, { mode: "push" });
  }, [worktree, openPane]);

  const enhancement = useMemo((): MarkdownEnhancement | null => {
    if (!worktree) return null;
    return {
      components: {
        img: ({ src, alt }) => {
          if (typeof src !== "string" || !src) return null;
          // THE place a persisted `/api/…` address in markdown becomes an
          // asset: an attachment (`![](/api/attachments/<id>)`) loads over the
          // subtree's transport like every other attachment image.
          const attachmentId = isAttachmentUrl(src);
          if (attachmentId !== null) {
            return (
              <AssetThumbnail
                asset={attachmentUrl(attachmentId)}
                image={{
                  name: alt || "Attached image",
                  sourceLabel: "Markdown",
                  alt: alt || undefined,
                }}
              />
            );
          }
          const isImage = IMG_HREF_RE.test(src);
          if (isImage && isExternalUrl(src)) {
            return (
              <ViewerThumbnail
                image={{
                  src,
                  name: basename(src),
                  sourceLabel: "Markdown",
                  alt: alt || undefined,
                }}
              />
            );
          }
          if (isImage) {
            return (
              <AssetThumbnail
                asset={fileUrl(
                  fileRefForPath(
                    worktree,
                    src,
                    worktreePath !== undefined ? { root: worktreePath } : {},
                  ),
                )}
                image={{
                  name: basename(src),
                  sourceLabel: "Markdown",
                  alt: alt || undefined,
                }}
              />
            );
          }
          if (fileTarget) {
            return (
              <LinkChip mono activation={fileTarget(src)}>
                {alt || src}
              </LinkChip>
            );
          }
          return null;
        },
      },
    };
  }, [worktree, worktreePath, fileTarget]);

  const value = useMarkdownEnhancement(enhancement);
  return (
    <MarkdownEnhancementContext.Provider value={value}>
      {children}
    </MarkdownEnhancementContext.Provider>
  );
}

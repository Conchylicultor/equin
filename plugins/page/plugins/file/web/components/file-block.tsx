import { AttachmentUpload } from "@plugins/page/plugins/attachment-block/web";
import { attachmentUrl } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/web";
import { useAssetSrc } from "@plugins/infra/plugins/endpoints/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Stack,
  Inset,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import type { BlockRendererProps } from "@plugins/page/plugins/editor/web";
import { fileBlock } from "../../core";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const attachFileIcon = symbol("attach-file");
const musicNoteIcon = symbol("music-note");
const downloadIcon = symbol("download");
const folderZipIcon = symbol("folder-zip");
const imageIcon = symbol("image");
const draftIcon = symbol("draft");
const movieIcon = symbol("movie");
const pictureAsPdfIcon = symbol("picture-as-pdf");
const swapHorizIcon = symbol("swap-horiz");

// Humanize a byte count: B / KB / MB / GB with one decimal above bytes.
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

// Pick a leading icon from the file's mime type.
function iconForMime(mime: string | undefined): IconRef {
  const m = (mime ?? "").toLowerCase();
  if (m === "application/pdf") return pictureAsPdfIcon;
  if (m.includes("zip") || m.includes("compressed") || m.includes("tar"))
    return folderZipIcon;
  if (m.startsWith("audio/")) return musicNoteIcon;
  if (m.startsWith("video/")) return movieIcon;
  if (m.startsWith("image/")) return imageIcon;
  return draftIcon;
}

export function FileBlock({ block, isFocused, editor }: BlockRendererProps) {
  const { attachmentId, filename, mime, size } = fileBlock.parse(block.data);

  if (!attachmentId) {
    return (
      <AttachmentUpload
        accept="*"
        label="Add a file — click, drop, or paste"
        icon={attachFileIcon}
        isFocused={isFocused}
        onUploaded={(res) =>
          editor.update({
            attachmentId: res.id,
            filename: res.filename,
            mime: res.mime,
            size: res.size,
          })
        }
      />
    );
  }

  return (
    <FilledFileBlock
      attachmentId={attachmentId}
      filename={filename}
      mime={mime}
      size={size}
      editor={editor}
    />
  );
}

/**
 * A file block with its file: a card that downloads it once its bytes are
 * loadable over the subtree's transport (`useAssetSrc`).
 */
function FilledFileBlock({
  attachmentId,
  filename,
  mime,
  size,
  editor,
}: {
  attachmentId: string;
  filename?: string;
  mime?: string;
  size?: number;
  editor: BlockRendererProps["editor"];
}) {
  const src = useAssetSrc(attachmentUrl(attachmentId));
  const iconEl = (
    <Icon
      icon={iconForMime(mime)}
      className={cn("size-6 text-muted-foreground", rigidClass())}
    />
  );
  const name = filename ?? "File";

  return (
    <Inset x="md" y="xs">
      <div className={cn(hoverRevealGroup, "relative")}>
        <Card
          as="a"
          interactive
          href={src.kind === "ready" ? src.src : undefined}
          download={name}
        >
          <Stack direction="row" align="center" gap="md">
            {iconEl}
            <Stack as={Fill} gap="none">
              <Text variant="label" className="truncate">
                {name}
              </Text>
              {size != null ? (
                <Text variant="caption" tone="muted">
                  {formatBytes(size)}
                </Text>
              ) : null}
            </Stack>
            <Icon
              icon={downloadIcon}
              className={cn("size-5 text-muted-foreground", rigidClass())}
            />
          </Stack>
        </Card>
        <Pin to="top-right" offset="xs">
          <button
            type="button"
            aria-label="Replace file"
            onClick={() => editor.update({})}
            className={cn(
              hoverRevealTarget,
              "size-6 rounded-full bg-black/50 text-white hover:bg-black/70",
            )}
          >
            <Center className="size-full">
              <Icon icon={swapHorizIcon} className="size-4" />
            </Center>
          </button>
        </Pin>
      </div>
    </Inset>
  );
}

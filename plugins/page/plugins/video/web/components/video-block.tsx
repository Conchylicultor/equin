import { AttachmentUpload } from "@plugins/page/plugins/attachment-block/web";
import { attachmentUrl } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/web";
import { useAssetSrc } from "@plugins/infra/plugins/endpoints/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import type { BlockRendererProps } from "@plugins/page/plugins/editor/web";
import { videoBlock } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const movieIcon = symbol("movie");
const swapHorizIcon = symbol("swap-horiz");

export function VideoBlock({ block, isFocused, editor }: BlockRendererProps) {
  const { attachmentId } = videoBlock.parse(block.data);

  if (!attachmentId) {
    return (
      <AttachmentUpload
        accept="video/*"
        label="Add a video — click, drop, or paste"
        icon={movieIcon}
        isFocused={isFocused}
        onUploaded={(res) =>
          editor.update({
            attachmentId: res.id,
            filename: res.filename,
            mime: res.mime,
          })
        }
      />
    );
  }

  return (
    <div className="px-md py-xs">
      <div className={cn(hoverRevealGroup, "relative")}>
        <AttachmentVideo attachmentId={attachmentId} />
        <Pin to="top-right" offset="xs">
          <button
            type="button"
            aria-label="Replace video"
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
    </div>
  );
}

/**
 * The video's player, its bytes loaded over the subtree's transport
 * (`useAssetSrc`): loading until loadable, the reason when it cannot be.
 */
function AttachmentVideo({ attachmentId }: { attachmentId: string }) {
  const src = useAssetSrc(attachmentUrl(attachmentId));
  switch (src.kind) {
    case "loading":
      return <Loading variant="spinner" />;
    case "unavailable":
    case "error":
      return (
        <Text variant="caption" tone="muted">
          {src.message}
        </Text>
      );
    case "ready":
      return (
        <video
          controls
          src={src.src}
          className="w-full max-w-full rounded-md"
        />
      );
  }
}

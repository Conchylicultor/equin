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
import { audioBlock } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const musicNoteIcon = symbol("music-note");
const swapHorizIcon = symbol("swap-horiz");

export function AudioBlock({ block, isFocused, editor }: BlockRendererProps) {
  const { attachmentId } = audioBlock.parse(block.data);

  if (!attachmentId) {
    return (
      <AttachmentUpload
        accept="audio/*"
        label="Add audio — click, drop, or paste"
        icon={musicNoteIcon}
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
        <AttachmentAudio attachmentId={attachmentId} />
        <Pin to="top-right" offset="xs">
          <button
            type="button"
            aria-label="Replace audio"
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
 * The audio's player, its bytes loaded over the subtree's transport
 * (`useAssetSrc`): loading until loadable, the reason when it cannot be.
 */
function AttachmentAudio({ attachmentId }: { attachmentId: string }) {
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
      return <audio controls src={src.src} className="w-full" />;
  }
}

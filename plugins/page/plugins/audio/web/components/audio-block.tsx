import { useState } from "react";
import { AttachmentUpload } from "@plugins/page/plugins/attachment-block/web";
import { attachmentUrl } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/web";
import { useAssetSrc } from "@plugins/infra/plugins/endpoints/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
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
import { MediaPlayer } from "@plugins/media/plugins/player/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";

const musicNoteIcon = symbol("music-note");
const swapHorizIcon = symbol("swap-horiz");

export function AudioBlock({ block, isFocused, editor }: BlockRendererProps) {
  const { attachmentId, filename } = audioBlock.parse(block.data);

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

  // The Replace button sits beside the bar, not pinned over it: the bar is
  // as tall as the button's corner, so a pin would cover its settings gear.
  return (
    <div className="px-md py-xs">
      <Stack
        direction="row"
        align="center"
        gap="xs"
        className={hoverRevealGroup}
      >
        <Fill>
          <AttachmentAudio
            attachmentId={attachmentId}
            label={filename ?? "Audio"}
          />
        </Fill>
        <button
          type="button"
          aria-label="Replace audio"
          onClick={() => editor.update({})}
          className={cn(
            hoverRevealTarget,
            rigidClass(),
            "size-6 rounded-full bg-black/50 text-white hover:bg-black/70",
          )}
        >
          <Center className="size-full">
            <Icon icon={swapHorizIcon} className="size-4" />
          </Center>
        </button>
      </Stack>
    </div>
  );
}

/**
 * The audio's player, its bytes loaded over the subtree's transport
 * (`useAssetSrc`): loading until loadable, the reason when it cannot be —
 * nor when the player cannot open or decode them.
 */
function AttachmentAudio({
  attachmentId,
  label,
}: {
  attachmentId: string;
  label: string;
}) {
  const src = useAssetSrc(attachmentUrl(attachmentId));
  // Keyed by address so a failure never sticks to a replaced file.
  const [failed, setFailed] = useState<{ src: string; message: string } | null>(
    null,
  );
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
      if (failed?.src === src.src) {
        return (
          <Text variant="caption" tone="muted">
            {failed.message}
          </Text>
        );
      }
      return (
        <MediaPlayer
          kind="audio"
          src={src.src}
          label={label}
          onError={(error) =>
            setFailed({ src: src.src, message: playbackFailure(error) })
          }
          className="w-full"
        />
      );
  }
}

/** Why the player gave up, in one caption line (its own message as detail). */
function playbackFailure(error: MediaError | null): string {
  const detail =
    error === null || error.message === "" ? "" : ` (${error.message})`;
  return `Can't play this audio file${detail}.`;
}

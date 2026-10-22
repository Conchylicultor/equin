import { useRef, useState } from "react";
import { AttachmentUpload } from "@plugins/page/plugins/attachment-block/web";
import { attachmentUrl } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/web";
import {
  ImageGallery,
  MissingImage,
  UnloadedAssetImage,
  useImageLoad,
  useImageViewerTrigger,
} from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import { useAssetSrc } from "@plugins/infra/plugins/endpoints/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import {
  BLOCK_INSET,
  type BlockRendererProps,
} from "@plugins/page/plugins/editor/web";
import { imageBlock } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const closeIcon = symbol("close");
const imageIcon = symbol("image");

const MIN_W = 80;
const DEFAULT_W = 480;

export function ImageBlock({ block, isFocused, editor }: BlockRendererProps) {
  const { attachmentId, width, alt } = imageBlock.parse(block.data);

  if (!attachmentId) {
    return (
      <AttachmentUpload
        accept="image/*"
        label="Add an image — click, drop, or paste"
        icon={imageIcon}
        isFocused={isFocused}
        onUploaded={(res) =>
          editor.update({ attachmentId: res.id, width: DEFAULT_W })
        }
      />
    );
  }

  return (
    // The block keeps its own <img>, so it renders the gallery its trigger
    // needs: a gallery of one, rendered inside the block.
    <ImageGallery>
      <FilledImageBlock
        attachmentId={attachmentId}
        width={width ?? DEFAULT_W}
        alt={alt}
        editor={editor}
      />
    </ImageGallery>
  );
}

interface FilledImageBlockProps {
  attachmentId: string;
  width: number;
  alt?: string;
  editor: BlockRendererProps["editor"];
}

/** The image's bytes, over the subtree's transport (`useAssetSrc`), then the block. */
function FilledImageBlock(props: FilledImageBlockProps) {
  const src = useAssetSrc(attachmentUrl(props.attachmentId));
  if (src.kind !== "ready") {
    return (
      <Inset x={BLOCK_INSET} y="xs">
        <UnloadedAssetImage src={src} name={props.alt || "Image"} />
      </Inset>
    );
  }
  return <LoadedImageBlock {...props} src={src.src} />;
}

function LoadedImageBlock({
  attachmentId,
  width,
  alt,
  editor,
  src,
}: FilledImageBlockProps & { src: string }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  // A click on the resizable <img> opens the full-window viewer.
  const viewerTrigger = useImageViewerTrigger<HTMLImageElement>({
    src,
    name: alt || "Image",
    alt: alt || undefined,
  });

  const { load, imgKey, imgProps, retry } = useImageLoad(src);
  const failed = load.kind === "failed";

  const displayWidth = liveWidth ?? width;

  function onResizePointerDown(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = width;
    const maxWidth = wrapperRef.current?.parentElement?.clientWidth ?? Infinity;

    let nextWidth = startWidth;
    function onMove(ev: PointerEvent) {
      const raw = startWidth + (ev.clientX - startX);
      nextWidth = Math.round(Math.min(Math.max(raw, MIN_W), maxWidth));
      setLiveWidth(nextWidth);
    }
    function onUp(ev: PointerEvent) {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      setLiveWidth(null);
      editor.update({ attachmentId, width: nextWidth, alt });
    }
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  return (
    <Inset x={BLOCK_INSET} y="xs">
      <div
        ref={wrapperRef}
        className={cn(hoverRevealGroup, "relative inline-block max-w-full")}
        // A missing image keeps the placeholder's own size, not the image's.
        style={failed ? undefined : { width: displayWidth }}
      >
        {failed ? (
          <MissingImage
            name={alt || "Image"}
            reason={load.reason}
            onRetry={retry}
          />
        ) : (
          <img
            key={imgKey}
            src={src}
            alt={alt ?? ""}
            {...viewerTrigger}
            {...imgProps}
            className="block w-full cursor-zoom-in rounded-md"
          />
        )}
        <Pin to="top-right" offset="xs">
          <button
            type="button"
            aria-label="Remove image"
            onClick={() => editor.update({ alt })}
            className={cn(
              hoverRevealTarget,
              "size-6 rounded-full bg-black/50 text-white hover:bg-black/70",
            )}
          >
            <Center className="size-full">
              <Icon icon={closeIcon} className="size-4" />
            </Center>
          </button>
        </Pin>
        {!failed && (
          <Pin
            to="right"
            stretch
            aria-label="Resize image"
            role="slider"
            onPointerDown={onResizePointerDown}
            className="w-2 cursor-ew-resize"
          >
            {/* eslint-disable-next-line layout/no-adhoc-layout -- fractional right-0.5 inset + vertical-center on the drag-grip bar is off the spacing ramp */}
            <div className="pointer-events-none absolute top-1/2 right-0.5 h-8 w-1 -translate-y-1/2 rounded-md bg-foreground/30 opacity-0 transition-opacity group-hover/hover-reveal:opacity-100" />
          </Pin>
        )}
      </div>
    </Inset>
  );
}

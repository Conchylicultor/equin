import { useRef, useState } from "react";

import { useLiveRow } from "@plugins/network/plugins/live/web";
import {
  useAssetSrc,
  useEndpointMutation,
  type AssetSrc,
} from "@plugins/infra/plugins/endpoints/web";
import {
  pagesTree,
  updateBlock,
  pageData,
  type Block,
  type PageCover,
} from "@plugins/page/plugins/editor/core";
import { attachmentUrl } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import {
  MissingImage,
  UnloadedAssetImage,
  useImageLoad,
  type ImageLoadState,
} from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import { gradientCss } from "./cover-presets";
import { ChangeCoverPopover } from "./change-cover-popover";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const swapVertIcon = symbol("swap-vert");
const imageIcon = symbol("image");
const deleteIcon = symbol("delete");
const checkIcon = symbol("check");
const closeIcon = symbol("close");

/**
 * The page cover band, full-bleed above the content column. Renders nothing
 * when no cover is set — the "Add cover" entry point lives in the header's
 * hover-affordance row, so the resting state stays clean (no empty band). With
 * a cover it renders the gradient/image, plus hover controls to change,
 * reposition (images only), or remove it.
 */
export function PageCover({ pageId }: { pageId: string }) {
  const result = useLiveRow(pagesTree, pageId);
  // Loading or failed: no band. The cover is decoration, and the page header
  // reads the same row and renders the failure.
  if (result.status === "loading" || result.status === "error") return null;
  if (!result.found) return null;
  return <PageCoverInner page={result.row} pageId={pageId} />;
}

function PageCoverInner({ page, pageId }: { page: Block; pageId: string }) {
  const data = pageData(page);
  const cover = data.cover ?? null;
  const { mutateAsync } = useEndpointMutation(updateBlock);

  const saveCover = async (next: PageCover | null) => {
    await mutateAsync({
      params: { id: pageId },
      body: { data: { ...pageData(page), cover: next } },
    });
  };

  if (!cover) return null;
  if (cover.type === "image") {
    return <ImageCover cover={cover} onPick={saveCover} onSave={saveCover} />;
  }
  return (
    <FilledCover
      band={{ kind: "gradient", cover }}
      onPick={saveCover}
      onSave={saveCover}
    />
  );
}

/**
 * An image cover: its bytes over the subtree's transport (`useAssetSrc`), then
 * its load state, which decides whether it can be repositioned.
 */
function ImageCover({
  cover,
  onPick,
  onSave,
}: {
  cover: ImageCoverValue;
  onPick: (cover: PageCover) => void;
  onSave: (cover: PageCover | null) => Promise<void>;
}) {
  const asset = useAssetSrc(attachmentUrl(cover.attachmentId));
  if (asset.kind !== "ready") {
    return (
      <FilledCover
        band={{ kind: "unloaded", cover, asset }}
        onPick={onPick}
        onSave={onSave}
      />
    );
  }
  return (
    <LoadedImageCover
      cover={cover}
      src={asset.src}
      onPick={onPick}
      onSave={onSave}
    />
  );
}

function LoadedImageCover({
  cover,
  src,
  onPick,
  onSave,
}: {
  cover: ImageCoverValue;
  src: string;
  onPick: (cover: PageCover) => void;
  onSave: (cover: PageCover | null) => Promise<void>;
}) {
  const image = useImageLoad(src);
  return (
    <FilledCover
      band={{ kind: "image", cover, src, image }}
      onPick={onPick}
      onSave={onSave}
    />
  );
}

type ImageCoverValue = Extract<PageCover, { type: "image" }>;

/**
 * What the band paints: a gradient, an image cover not loadable yet (or here),
 * or an image cover with its load state.
 */
type CoverBand =
  | { kind: "gradient"; cover: Exclude<PageCover, ImageCoverValue> }
  | {
      kind: "unloaded";
      cover: ImageCoverValue;
      asset: Exclude<AssetSrc, { kind: "ready" }>;
    }
  | {
      kind: "image";
      cover: ImageCoverValue;
      src: string;
      image: ImageLoadState;
    };

function FilledCover({
  band,
  onPick,
  onSave,
}: {
  band: CoverBand;
  onPick: (cover: PageCover) => void;
  onSave: (cover: PageCover | null) => Promise<void>;
}) {
  const [repositioning, setRepositioning] = useState(false);
  const { cover } = band;
  // A cover whose file no longer loads has nothing to reposition; it can still
  // be changed or removed.
  const failed = band.kind === "image" && band.image.load.kind === "failed";

  return (
    <Clip
      className={cn(
        hoverRevealGroup,
        "group/cover relative h-[30vh] max-h-64 w-full select-none",
      )}
    >
      {band.kind === "gradient" ? (
        <div
          className="size-full"
          style={{ background: gradientCss(band.cover.preset) }}
        />
      ) : band.kind === "unloaded" ? (
        <UnloadedAssetImage src={band.asset} name="Cover image" size="fill" />
      ) : band.image.load.kind === "failed" ? (
        <MissingImage
          name="Cover image"
          reason={band.image.load.reason}
          onRetry={band.image.retry}
          size="fill"
        />
      ) : (
        <CoverImage
          cover={band.cover}
          src={band.src}
          image={band.image}
          repositioning={repositioning}
          onSave={onSave}
          onDone={() => setRepositioning(false)}
        />
      )}

      {!repositioning && (
        <Pin to="bottom-right" offset="md" className={hoverRevealTarget}>
          <Stack direction="row" gap="xs">
            <ChangeCoverPopover
              current={cover}
              onPick={onPick}
              trigger={
                <Button variant="secondary">
                  <Icon icon={imageIcon} />
                  Change cover
                </Button>
              }
            />
            {band.kind === "image" && !failed && (
              <Button
                variant="secondary"
                onClick={() => setRepositioning(true)}
              >
                <Icon icon={swapVertIcon} />
                Reposition
              </Button>
            )}
            <IconButton
              icon={deleteIcon}
              label="Remove cover"
              variant="secondary"
              onClick={() => void onSave(null)}
            />
          </Stack>
        </Pin>
      )}
    </Clip>
  );
}

/**
 * The image cover, with an opt-in vertical reposition mode. While
 * repositioning, a vertical pointer drag adjusts the local `positionY` (0-100,
 * applied as `object-position` Y%). Pointer capture keeps the drag bound to the
 * element — no window-level listeners left mounted. Save commits; Cancel
 * reverts to the persisted value.
 */
function CoverImage({
  cover,
  src,
  image,
  repositioning,
  onSave,
  onDone,
}: {
  cover: ImageCoverValue;
  src: string;
  image: ImageLoadState;
  repositioning: boolean;
  onSave: (cover: PageCover | null) => Promise<void>;
  onDone: () => void;
}) {
  const [localY, setLocalY] = useState(cover.positionY);
  const dragRef = useRef<{
    startClientY: number;
    startY: number;
    height: number;
  } | null>(null);

  const positionY = repositioning ? localY : cover.positionY;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!repositioning) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    dragRef.current = {
      startClientY: e.clientY,
      startY: localY,
      height: el.clientHeight,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Drag up reveals lower part of the image (increase Y%); scale the pixel
    // delta to the band height so a full-band drag covers the full 0-100 range.
    const delta =
      ((e.clientY - drag.startClientY) / Math.max(drag.height, 1)) * 100;
    const next = Math.min(100, Math.max(0, drag.startY + delta));
    setLocalY(next);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) {
      e.currentTarget.releasePointerCapture(e.pointerId);
      dragRef.current = null;
    }
  };

  const save = async () => {
    await onSave({ ...cover, positionY: localY });
    onDone();
  };

  const cancel = () => {
    setLocalY(cover.positionY);
    onDone();
  };

  return (
    <>
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={cn(
          "size-full",
          repositioning && "cursor-grab active:cursor-grabbing",
        )}
      >
        <img
          key={image.imgKey}
          src={src}
          alt=""
          {...image.imgProps}
          draggable={false}
          className="pointer-events-none size-full object-cover"
          style={{ objectPosition: `50% ${positionY}%` }}
        />
      </div>

      {repositioning && (
        <>
          <Pin to="top" offset="md" stretch decorative>
            <Center axis="horizontal">
              <Text
                as="span"
                variant="caption"
                className="rounded-md bg-black/60 px-sm py-2xs text-white"
              >
                Drag image to reposition
              </Text>
            </Center>
          </Pin>
          <Pin to="bottom-right" offset="md">
            <Stack direction="row" gap="xs">
              <Button variant="secondary" onClick={cancel}>
                <Icon icon={closeIcon} />
                Cancel
              </Button>
              <Button variant="default" onClick={() => void save()}>
                <Icon icon={checkIcon} />
                Save
              </Button>
            </Stack>
          </Pin>
        </>
      )}
    </>
  );
}

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { clipClasses } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { layerClasses } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { revealElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import {
  NewTabGlyph,
  newTabAnchorProps,
} from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";
import {
  ImageGallery,
  ImageViewer,
  useImageViewerTrigger,
  type ViewerImage,
} from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { PlacePhoto } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import {
  PHOTO_WIDTH,
  placePhotoAsset,
} from "@plugins/apps/plugins/places/plugins/place-details/core";
import {
  useAssetSrcs,
  type AssetSrc,
} from "@plugins/infra/plugins/endpoints/web";
import { usePhotoSrcs } from "../internal/photo-src";
import { mapsHref, type MapsLinkPlace } from "../internal/maps-links";

const backIcon = symbol("arrow-back");

/** The card's width while it shows the photos: room for two big columns. */
export const PLACE_PHOTOS_WIDTH = "760px";

/** How many thumbnails the card's photo row shows (the last one says "+N"). */
const THUMB_COUNT = 4;

/**
 * The width the hero strip and the photos grid both fetch a photo at — about
 * twice the card's width and the grid's ~370px column, for hi-dpi. One width
 * for both, so a photo the strip already loaded opens in the grid from the
 * browser's cache instead of a second (billed) fetch.
 */
export const PHOTO_FETCH_PX = 720;

/**
 * One photo as the viewer shows it: the largest copy the photo route serves,
 * with that copy's size (the viewer's fit and zoom read it), credited to its
 * author — Google's terms require it beside the photo.
 */
function viewerWidth(photo: PlacePhoto): number {
  return Math.min(photo.widthPx, PHOTO_WIDTH.max);
}

function viewerImage(photo: PlacePhoto, n: number, src: string): ViewerImage {
  const width = viewerWidth(photo);
  return {
    src,
    name: photo.authors[0]?.name ?? `Photo ${n + 1}`,
    sourceLabel: "Google",
    width,
    height: Math.round((width * photo.heightPx) / photo.widthPx),
  };
}

/**
 * The card's photo row, under the place's name: the first few photos after
 * the hero's, the last one veiled with how many more there are. A thumbnail
 * opens that photo in the viewer (← / → through all of them); "See all" and
 * the veiled one open the photos panel. Nothing for a place with no more
 * photos than the hero's one.
 */
export function PhotoThumbs({
  photos,
  onShowAll,
}: {
  photos: readonly PlacePhoto[];
  onShowAll: () => void;
}): ReactNode {
  const [open, setOpen] = useState<number | null>(null);
  const thumbs = useRef<(HTMLElement | null)[]>([]);
  const shown = photos.slice(1, 1 + THUMB_COUNT);
  const thumbSrcs = usePhotoSrcs(
    shown.map((p) => placePhotoAsset(p.name, PHOTO_WIDTH.min)),
  );
  const viewerSrcs = usePhotoSrcs(
    photos.map((p) => placePhotoAsset(p.name, viewerWidth(p))),
  );
  if (photos.length < 2) return null;
  const more = photos.length - 1 - shown.length;
  return (
    <Stack gap="xs">
      <Stack direction="row" gap="sm" justify="between" align="center">
        <Text variant="body" tone="strong">
          Photos
        </Text>
        <Button variant="link" aspect="inline" onClick={onShowAll}>
          {`See all ${photos.length}`}
        </Button>
      </Stack>
      <Grid cols={4} gap="xs">
        {shown.map((p, j) => {
          const veiled = more > 0 && j === shown.length - 1;
          return (
            <button
              key={p.name}
              type="button"
              ref={(el) => {
                thumbs.current[j + 1] = el;
              }}
              aria-label={veiled ? `All ${photos.length} photos` : "Open photo"}
              onClick={() => (veiled ? onShowAll() : setOpen(j + 1))}
              className={cn(
                "relative aspect-square rounded-md bg-muted",
                clipClasses({ axis: "both", fill: false }),
              )}
            >
              {thumbSrcs === null ? null : (
                <img
                  src={thumbSrcs[j]}
                  alt=""
                  loading="lazy"
                  className="size-full object-cover"
                />
              )}
              {veiled ? (
                <Center
                  as="span"
                  className={cn(
                    layerClasses(),
                    "bg-black/50 text-title text-white",
                  )}
                >
                  {`+${more + 1}`}
                </Center>
              ) : null}
            </button>
          );
        })}
      </Grid>
      {open === null || viewerSrcs === null ? null : (
        <ImageViewer
          images={photos.map((p, i) => viewerImage(p, i, viewerSrcs[i]!))}
          index={open}
          onIndexChange={setOpen}
          onClose={() => setOpen(null)}
          originOf={(i) => thumbs.current[i] ?? null}
        />
      )}
    </Stack>
  );
}

/**
 * The card's width, animated between its own (`base`) and the photos panel's:
 * the card and its panel are ONE element, so the change of width glides
 * instead of swapping boxes.
 */
export function cardWidthProps(
  base: string,
  photosOpen: boolean,
): { className: string; style: { width: string } } {
  return {
    className:
      "transition-[width] duration-300 ease-[cubic-bezier(.2,.8,.2,1)]",
    style: {
      width: photosOpen
        ? `min(${PLACE_PHOTOS_WIDTH}, calc(100vw - 2rem))`
        : base,
    },
  };
}

/**
 * Brings its scroller back to the top when it mounts — the card's body and
 * its photos share one scroller, so switching between them would otherwise
 * keep the other's scroll offset.
 */
export function ScrollTopOnMount(): ReactNode {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    revealElement(ref.current, { block: "start", scope: "nearest" });
  }, []);
  return <span ref={ref} aria-hidden className="block" />;
}

/** The photos panel's header: Back, then what it shows. */
export function PhotosHeader({
  place,
  count,
  onBack,
}: {
  place: MapsLinkPlace;
  count: number;
  onBack: () => void;
}): ReactNode {
  return (
    <Line className="gap-xs border-b px-sm py-xs">
      <IconButton icon={backIcon} label="Back" onClick={onBack} />
      <Fill>
        <Stack gap="none">
          <Text variant="body" tone="strong">
            Photos
          </Text>
          <Text variant="caption" tone="muted">
            {`${place.name} · ${count} from Google`}
          </Text>
        </Stack>
      </Fill>
    </Line>
  );
}

/**
 * The place card turned into its photos: every photo Google shares (at most
 * ten) in two columns at its own shape, each credited on hover — the place's
 * own uploads marked Owner — then a last tile to the full album on Google
 * Maps. A photo opens the viewer, stepping through the rest. Laid out at
 * once but held invisible until every photo has loaded (or failed), then
 * fades in while the card widens around it — never a frame of empty tiles
 * filling in one by one. While held it is busy (a delayed spinner), so a
 * slow photo reads as loading.
 */
export function PhotosGrid({
  photos,
  place,
}: {
  photos: readonly PlacePhoto[];
  /** Google's name for it (an author by that name is the place itself) and its link. */
  place: MapsLinkPlace;
}): ReactNode {
  const tileSrcs = useAssetSrcs(
    photos.map((p) => placePhotoAsset(p.name, PHOTO_FETCH_PX)),
  );
  const viewerSrcs = useAssetSrcs(
    photos.map((p) => placePhotoAsset(p.name, viewerWidth(p))),
  );
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());
  // A photo with no image to load here (not available on this host, or its
  // address failed) draws its muted tile and holds nothing back.
  const ready = photos.every(
    (p, i) =>
      settled.has(p.name) ||
      unloadable(tileSrcs[i]) ||
      unloadable(viewerSrcs[i]),
  );
  const settle = (name: string) =>
    setSettled((s) => (s.has(name) ? s : new Set(s).add(name)));
  return (
    <ImageGallery>
      <ScrollTopOnMount />
      <div className="relative">
        {ready ? null : (
          <Pin to="top" offset="md" layer="float">
            <Loading variant="spinner" label="Loading photos…" />
          </Pin>
        )}
        <div
          className={cn(
            "columns-2 gap-xs p-xs",
            ready ? "animate-in fade-in-0 duration-300" : "invisible",
          )}
        >
          {photos.map((p, i) => (
            <PhotoTile
              key={p.name}
              photo={p}
              n={i}
              owner={p.authors[0]?.name === place.name}
              tileSrc={readySrc(tileSrcs[i])}
              viewerSrc={readySrc(viewerSrcs[i])}
              onSettled={() => settle(p.name)}
            />
          ))}
          <a
            {...newTabAnchorProps(mapsHref(place))}
            title="Google shares at most ten photos with apps; its Maps page has the full album"
            className="block break-inside-avoid rounded-md border border-dashed text-muted-foreground hover:border-primary hover:text-primary-text"
          >
            <Center className="aspect-[4/3]">
              <Stack gap="2xs" align="center">
                <NewTabGlyph className="size-5" />
                <Text variant="body" tone="strong">
                  More on Google Maps
                </Text>
                <Text variant="caption" tone="muted">
                  The full album
                </Text>
              </Stack>
            </Center>
          </a>
        </div>
      </div>
    </ImageGallery>
  );
}

/** No image will come of it: not available on this host, or it failed. */
function unloadable(src: AssetSrc | undefined): boolean {
  return src?.kind === "unavailable" || src?.kind === "error";
}

function readySrc(src: AssetSrc | undefined): string | null {
  return src?.kind === "ready" ? src.src : null;
}

/** A grid tile's photo, opening the viewer on a click. */
function PhotoTileImage({
  photo,
  n,
  src,
  viewerSrc,
  onSettled,
}: {
  photo: PlacePhoto;
  n: number;
  src: string;
  viewerSrc: string;
  onSettled: () => void;
}): ReactNode {
  const trigger = useImageViewerTrigger<HTMLImageElement>(
    viewerImage(photo, n, viewerSrc),
  );
  const author = photo.authors[0];
  return (
    <img
      src={src}
      alt={author === undefined ? "" : `Photo by ${author.name}`}
      // Eager, every one: the grid waits for them all (at most ten).
      loading="eager"
      onLoad={onSettled}
      onError={onSettled}
      className="size-full cursor-zoom-in object-cover"
      {...trigger}
    />
  );
}

/** One photo of the panel's grid: its own shape, its author on hover. */
function PhotoTile({
  photo,
  n,
  owner,
  tileSrc,
  viewerSrc,
  onSettled,
}: {
  photo: PlacePhoto;
  n: number;
  owner: boolean;
  /** What the tile and the viewer load, once loadable (null until then). */
  tileSrc: string | null;
  viewerSrc: string | null;
  /** Its image loaded or failed — either way, it no longer holds the grid back. */
  onSettled: () => void;
}): ReactNode {
  const author = photo.authors[0];
  return (
    // The columns' vertical gap: padding, since a column flow has no row gap.
    <div className="break-inside-avoid pb-xs">
      <div
        className={cn(
          hoverRevealGroup,
          "relative rounded-md bg-muted",
          clipClasses({ axis: "both", fill: false }),
        )}
        style={{ aspectRatio: `${photo.widthPx} / ${photo.heightPx}` }}
      >
        {tileSrc === null || viewerSrc === null ? null : (
          <PhotoTileImage
            photo={photo}
            n={n}
            src={tileSrc}
            viewerSrc={viewerSrc}
            onSettled={onSettled}
          />
        )}
        {owner ? (
          <Pin to="top-right" offset="sm" layer="float">
            <span className="rounded-full bg-white/90 px-xs text-caption text-black">
              Owner
            </span>
          </Pin>
        ) : null}
        {author !== undefined ? (
          <Pin
            to="bottom-left"
            offset="sm"
            layer="float"
            className={hoverRevealTarget}
          >
            <span className="rounded-full bg-black/55 px-xs text-caption text-white backdrop-blur-sm">
              {author.uri !== undefined ? (
                <a
                  href={author.uri}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  {author.name}
                </a>
              ) : (
                author.name
              )}
            </span>
          </Pin>
        ) : null}
      </div>
    </div>
  );
}

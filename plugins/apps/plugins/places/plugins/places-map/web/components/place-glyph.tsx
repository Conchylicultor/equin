import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { placeThumbnailAsset } from "@plugins/apps/plugins/places/plugins/place-details/core";
import { usePhotoSrc } from "../internal/photo-src";
import { useState, type ReactNode } from "react";
import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import type { PlaceVisual } from "../internal/place-visual";
import { paleTint, washInk } from "../internal/pin-paint";

/**
 * A place's icon on a disc of its main colour — a list row's leading glyph.
 * Like the pin, a place not marked Want to go is pale: the pale tint, the
 * icon in the darkened main colour.
 */
export function PlaceGlyph({ visual }: { visual: PlaceVisual }) {
  const pale = !visual.want;
  return (
    <Center
      as="span"
      className="size-6 rounded-full"
      style={{
        backgroundColor: pale ? paleTint(visual.mainColor) : visual.mainColor,
      }}
    >
      <Icon
        icon={visual.icon}
        active
        className="size-4"
        style={{ color: pale ? washInk(visual.mainColor) : "white" }}
      />
    </Center>
  );
}

/** A place's colours as a pale wash: its one colour, or a diagonal blend. */
function washBackground(
  visual: Pick<PlaceVisual, "colors" | "mainColor">,
): string {
  return visual.colors.length > 1
    ? `linear-gradient(135deg, ${visual.colors.map(paleTint).join(", ")})`
    : paleTint(visual.mainColor);
}

/**
 * Google's first photo of a place (a thumbnail the server fetches once and
 * keeps), over its colours as a pale wash (a diagonal blend for several) with
 * its icon in the darkened main colour — the wash shows while the photo
 * loads, and stays for a custom place (`googlePlaceId: null`) or one Google
 * has no photo of. Fills its box; `children` overlay it.
 */
export function PlacePhotoWash({
  visual,
  googlePlaceId,
  iconClassName,
  children,
}: {
  visual: Pick<PlaceVisual, "colors" | "mainColor" | "icon">;
  googlePlaceId: string | null;
  /** The watermark icon's size (a cover's, a thumbnail's). */
  iconClassName: ClassName;
  children?: ReactNode;
}) {
  // 404 (no photo) or 503 (Maps not set up), or no photo here at all (a host
  // without the computer): the wash is the picture.
  const [noPhoto, setNoPhoto] = useState(false);
  const background = washBackground(visual);
  return (
    <Center className="relative size-full" style={{ background }}>
      <Icon
        icon={visual.icon}
        active
        className={iconClassName}
        style={{ color: washInk(visual.mainColor) }}
      />
      {googlePlaceId !== null && !noPhoto ? (
        <PlaceThumbnail
          googlePlaceId={googlePlaceId}
          onError={() => setNoPhoto(true)}
        />
      ) : null}
      {children}
    </Center>
  );
}

/** Google's first photo of a place, once it is loadable here (else the wash shows). */
function PlaceThumbnail({
  googlePlaceId,
  onError,
}: {
  googlePlaceId: string;
  onError: () => void;
}) {
  const src = usePhotoSrc(placeThumbnailAsset(googlePlaceId));
  if (src === null) return null;
  return (
    <Layer decorative>
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        className="size-full object-cover"
        onError={onError}
      />
    </Layer>
  );
}

/**
 * A place's gallery cover: its {@link PlacePhotoWash} with the icon large,
 * and a pill in the corner for each of Want to go and Been it carries (both,
 * one or none).
 */
export function PlaceCover({
  visual,
  googlePlaceId,
}: {
  visual: PlaceVisual;
  googlePlaceId: string | null;
}) {
  return (
    <PlacePhotoWash
      visual={visual}
      googlePlaceId={googlePlaceId}
      iconClassName={cn("size-10")}
    >
      {visual.want || visual.been ? (
        <Pin to="top-right" offset="sm">
          <PlaceStatusBadges want={visual.want} been={visual.been} />
        </Pin>
      ) : null}
    </PlacePhotoWash>
  );
}

/** Want to go and Been as their pills, in a row (both, one or none) — a
 *  place's cover, and its status in the side panel's list. */
export function PlaceStatusBadges({
  want,
  been,
}: {
  want: boolean;
  been: boolean;
}) {
  if (!want && !been) return null;
  return (
    <Cluster gap="2xs">
      {want ? (
        <Badge variant="muted" shape="pill">
          Want to go
        </Badge>
      ) : null}
      {been ? (
        <Badge variant="success" shape="pill">
          ✓ Been
        </Badge>
      ) : null}
    </Cluster>
  );
}

/**
 * A place's icon on a rounded square of its colours' pale wash — the side
 * panel list's leading tile. Never Google's photo: a list row is too small
 * to read one, and every row would fetch it.
 */
export function PlaceTile({ visual }: { visual: PlaceVisual }) {
  const background = washBackground(visual);
  return (
    <Center
      as="span"
      // A rigid leaf: the tile keeps its size however long the row's text.
      className={cn("size-10 rounded-lg", rigidClass())}
      style={{ background }}
    >
      <Icon
        icon={visual.icon}
        active
        className="size-5"
        style={{ color: washInk(visual.mainColor) }}
      />
    </Center>
  );
}

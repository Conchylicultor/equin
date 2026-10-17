import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { placeThumbnailUrl } from "@plugins/apps/plugins/places/plugins/place-details/core";
import { useState } from "react";
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

/**
 * A place's gallery cover: Google's first photo of it (a thumbnail the server
 * fetches once and keeps), over its colours as a pale wash (a diagonal blend
 * for several) with its icon large in the darkened main colour — the wash
 * shows while the photo loads, and stays for a custom place or one Google has
 * no photo of. A pill in the corner for each of Want to go and Been it
 * carries (both, one or none).
 */
export function PlaceCover({
  visual,
  googlePlaceId,
}: {
  visual: PlaceVisual;
  googlePlaceId: string | null;
}) {
  // 404 (no photo) or 503 (Maps not set up): the wash is the cover.
  const [noPhoto, setNoPhoto] = useState(false);
  const background =
    visual.colors.length > 1
      ? `linear-gradient(135deg, ${visual.colors.map(paleTint).join(", ")})`
      : paleTint(visual.mainColor);
  return (
    <Center className="relative size-full" style={{ background }}>
      <Icon
        icon={visual.icon}
        active
        className="size-10"
        style={{ color: washInk(visual.mainColor) }}
      />
      {googlePlaceId !== null && !noPhoto ? (
        <Layer decorative>
          <img
            src={placeThumbnailUrl(googlePlaceId)}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-cover"
            onError={() => setNoPhoto(true)}
          />
        </Layer>
      ) : null}
      {visual.want || visual.been ? (
        <Pin to="top-right" offset="sm">
          <Cluster gap="2xs">
            {visual.want ? (
              <Badge variant="muted" shape="pill">
                Want to go
              </Badge>
            ) : null}
            {visual.been ? (
              <Badge variant="success" shape="pill">
                ✓ Been
              </Badge>
            ) : null}
          </Cluster>
        </Pin>
      ) : null}
    </Center>
  );
}

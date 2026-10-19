import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  MARK_PENDING,
  MARK_SHADOW_PAD,
  escapeSvg,
  markIdPrefix,
  markShadow,
  markSvg,
  type MapMarkResult,
  type MapPin,
} from "@plugins/map/core";
import {
  MapLabel,
  MapMarkImage,
  useMapMarkEnv,
  type MapMarkEnv,
  type MapPinMarkFn,
  type MapPinProps,
} from "@plugins/map/web";
import { hash53 } from "@plugins/packages/plugins/string-hash/core";
import { readGoogleResultVisual } from "../internal/google-result";
import { washInk } from "../internal/pin-paint";

/** The ghost disc's box, px. */
const DISC_PX = 28;
const RING_PX = 2;
const ICON_PX = 16;
/** The disc's white, a touch see-through: a proposal, not a place of yours. */
const FILL_OPACITY = 0.92;
/** Air between the disc and its name. */
const LABEL_GAP_PX = 4;

/**
 * A Google result's ghost disc. At rest (`on: false`) its ring is dashed — a
 * proposal on the map, not one of your places; hovered (its pin, or its card
 * beside the map) the ring turns solid.
 */
function ghostMark(pin: MapPin, env: MapMarkEnv, on: boolean): MapMarkResult {
  const visual = readGoogleResultVisual(pin);
  const icon = env.icon(visual.icon, { active: true });
  if (icon.kind === "pending") return MARK_PENDING;
  const ink = env.color(washInk(visual.mainColor));
  const key = [
    "google-result",
    on ? "on" : "rest",
    ink,
    hash53(icon.viewBox + icon.body).toString(36),
  ].join("|");
  const id = markIdPrefix(key);
  const { x: px, top, bottom } = MARK_SHADOW_PAD;
  const c = DISC_PX / 2;
  const r = c - RING_PX / 2;
  const i = (DISC_PX - ICON_PX) / 2;
  const inkAttr = escapeSvg(ink);
  const body =
    `<defs>${markShadow(`${id}s`)}</defs>` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="#fff" fill-opacity="${FILL_OPACITY}" stroke="${inkAttr}" stroke-width="${RING_PX}"${on ? "" : ` stroke-dasharray="4 3"`} filter="url(#${id}s)"/>` +
    `<svg x="${i}" y="${i}" width="${ICON_PX}" height="${ICON_PX}" viewBox="${escapeSvg(icon.viewBox)}" style="color:${inkAttr};fill:${inkAttr}" overflow="visible">${icon.body}</svg>`;
  const width = DISC_PX + 2 * px;
  const height = DISC_PX + top + bottom;
  return {
    kind: "mark",
    key,
    svg: markSvg(
      width,
      height,
      `<g transform="translate(${px} ${top})">${body}</g>`,
    ),
    width,
    height,
    anchor: { x: px + c, y: top + c },
    labelAt: { x: px + DISC_PX + LABEL_GAP_PX, centerY: top + c },
  };
}

/** `GeoMap.Pin`'s mark for a Google result: the dashed ghost disc. */
export const googleResultMark: MapPinMarkFn = ({ pin }, env) =>
  ghostMark(pin, env, false);

/**
 * A Google result lifted into the DOM — which happens only while it is
 * hovered, on the map or through its card: the disc grows from its centre,
 * its ring turns solid and its name shows beside it.
 */
export function GoogleResultPin({ pin, tiles }: MapPinProps) {
  const env = useMapMarkEnv(tiles);
  if (env === null) return null;
  const mark = ghostMark(pin, env, true);
  if (mark.kind === "pending") return null;
  const name = pin.label ?? "Google result";
  return (
    <span
      role="img"
      aria-label={name}
      className="relative block cursor-pointer"
      style={{ width: mark.width, height: mark.height }}
    >
      <MapMarkImage
        mark={mark}
        className={cn("scale-[1.3] transition-transform")}
        style={{ transformOrigin: `${mark.anchor.x}px ${mark.anchor.y}px` }}
      />
      <Placed
        x={{ start: mark.labelAt.x + 4 }}
        y={{ center: mark.labelAt.centerY }}
        className="max-w-48 whitespace-nowrap"
      >
        <MapLabel tiles={tiles}>{name}</MapLabel>
      </Placed>
    </span>
  );
}

import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import {
  MARK_SHADOW_PAD,
  markIdPrefix,
  markShadow,
  markSvg,
  type MapMarkResult,
} from "../../core";
import type { MapPinMarkFn, MapPinProps } from "../slots";
import { MapLabel } from "./map-label";
import { MapMarkImage, useMapMarkEnv } from "./mark-env";

/** Air between the dot and its spot's count. */
const COUNT_GAP_PX = 4;

/** The dot's diameter: near, and far out (spots mode). */
const DOT_PX = { near: 16, far: 12 } as const;
const BORDER_PX = 2;

/**
 * The mark of a type nobody claimed: a neutral dot in the theme's primary
 * tone, a background-coloured ring and a soft shadow. Round, so it reads the
 * same near and far.
 */
export const defaultPinMark: MapPinMarkFn = ({ scale }, env) => {
  const d = DOT_PX[scale];
  const fill = env.color("var(--primary)");
  const ring = env.color("var(--background)");
  const key = `default-pin:${d}:${fill}:${ring}`;
  const id = markIdPrefix(key);
  const { x: px, top, bottom } = MARK_SHADOW_PAD;
  const width = d + 2 * px;
  const height = d + top + bottom;
  const r = d / 2;
  const body =
    `<defs>${markShadow(`${id}s`)}</defs>` +
    `<circle cx="${px + r}" cy="${top + r}" r="${r - BORDER_PX / 2}" fill="${fill}" stroke="${ring}" stroke-width="${BORDER_PX}" filter="url(#${id}s)"/>`;
  return {
    kind: "mark",
    key,
    svg: markSvg(width, height, body),
    width,
    height,
    anchor: { x: px + r, y: top + r },
    labelAt: { x: px + d + COUNT_GAP_PX, centerY: top + r },
  };
};

/**
 * The pin of a type nobody claimed, lifted into the DOM: its mark, grown while
 * active, with the spot's size beside it as a lead. Plain on purpose — a type's
 * owner contributes its real look through `GeoMap.Pin`.
 */
export function DefaultPin({ pin, active, scale, spot, tiles }: MapPinProps) {
  const env = useMapMarkEnv(tiles);
  if (env === null) return null;
  const mark: MapMarkResult = defaultPinMark({ pin, scale }, env);
  if (mark.kind === "pending") return null;
  return (
    <span
      role="img"
      aria-label={pin.label ?? "Map pin"}
      title={pin.label}
      className="relative block"
      style={{ width: mark.width, height: mark.height }}
    >
      <MapMarkImage
        mark={mark}
        className={cn("transition-transform", active && "scale-125")}
        style={{ transformOrigin: `${mark.anchor.x}px ${mark.anchor.y}px` }}
      />
      {spot === undefined ? null : (
        <Placed
          x={{ start: mark.labelAt.x }}
          y={{ center: mark.labelAt.centerY }}
          decorative
          className={cn("transition-opacity", spot.hushed && "opacity-0")}
        >
          <MapLabel tiles={tiles}>{spot.count}</MapLabel>
        </Placed>
      )}
    </span>
  );
}

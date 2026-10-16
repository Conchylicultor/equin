import type { ReactNode } from "react";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  MARK_PENDING,
  MARK_SHADOW_PAD,
  markIdPrefix,
  markSvg,
  type MapMark,
  type MapTileScheme,
} from "@plugins/map/core";
import {
  MapLabel,
  MapMarkImage,
  useMapMarkEnv,
  type MapPinMarkFn,
  type MapPinProps,
} from "@plugins/map/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { hash53 } from "@plugins/packages/plugins/string-hash/core";
import { readPlaceVisual } from "../internal/place-visual";
import { DROP_HEAD_PX, placeDropSvg } from "./place-drop";

/** The drop's head on the map: 0.8× the design size, so a street holds more. */
const PIN_HEAD_PX = 24;

/** How far the tip sits below the head's top: a radius plus the turned corner's reach (√2·r). */
const PIN_TIP_PX = Math.round(PIN_HEAD_PX / 2 + PIN_HEAD_PX / Math.SQRT2);

/** Far out, the round badge a place shrinks to: 0.78× the pin's head. */
const BADGE_PX = Math.round(PIN_HEAD_PX * 0.78);

/** Air between a mark and the text beside it. */
const LABEL_GAP_PX = 4;

/** The ground ellipse in head units (8, 33, 14, 6 on the 30px design head). */
const ground = (px: number) => Math.round((px * PIN_HEAD_PX) / DROP_HEAD_PX);

/** The soft ellipse's darkness at its middle; a pale (not Want to go) place's is faded. */
const GROUND_ALPHA = 0.32;
const PALE_GROUND_OPACITY = 0.6;

/**
 * A saved place's mark (`GeoMap.Pin`'s `mark` for `saved-place`).
 *
 * Near: the drop (`placeDropSvg`), its tip on the point, standing on a soft
 * ground shadow. Far (zoomed out): a small round badge in the same paint,
 * centred on the place. The map draws a spot's size beside a far lead itself.
 */
export const savedPlaceMark: MapPinMarkFn = ({ pin, scale }, env) => {
  const visual = readPlaceVisual(pin);
  const icon = env.icon(visual.icon, { active: true });
  if (icon.kind === "pending") return MARK_PENDING;
  const far = scale === "far";
  const head = far ? BADGE_PX : PIN_HEAD_PX;
  const key = [
    "saved-place",
    scale,
    visual.colors.map(env.color).join(","),
    visual.want ? "want" : "pale",
    env.color("var(--categorical-foreground)"),
    hash53(icon.viewBox + icon.body).toString(36),
  ].join("|");
  const id = markIdPrefix(key);
  const { x: px, top, bottom } = MARK_SHADOW_PAD;
  const body = placeDropSvg({
    visual,
    shape: far ? "disc" : "drop",
    sizePx: head,
    icon,
    paint: env.color,
    id,
  });
  const contentH = far ? head : ground(33) + ground(6);
  const width = head + 2 * px;
  const height = contentH + top + bottom;
  const groundShadow = far
    ? ""
    : `<defs><radialGradient id="${id}g"><stop offset="0" stop-color="#000" stop-opacity="${GROUND_ALPHA}"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient></defs>` +
      `<ellipse cx="${ground(8) + ground(14) / 2}" cy="${ground(33) + ground(6) / 2}" rx="${ground(14) / 2}" ry="${ground(6) / 2}" fill="url(#${id}g)"${visual.want ? "" : ` opacity="${PALE_GROUND_OPACITY}"`}/>`;
  return {
    kind: "mark",
    key,
    svg: markSvg(
      width,
      height,
      `<g transform="translate(${px} ${top})">${groundShadow}${body}</g>`,
    ),
    width,
    height,
    anchor: far
      ? { x: px + head / 2, y: top + head / 2 }
      : { x: px + head / 2, y: top + PIN_TIP_PX },
    labelAt: { x: px + head + LABEL_GAP_PX, centerY: top + head / 2 },
  } satisfies MapMark;
};

/**
 * A saved place lifted into the DOM (hovered or selected): its mark, lifted
 * on hover and grown from its anchor while active, with its name beside it as
 * a halo `MapLabel` on hover and while selected — never always-on: at street
 * level the names would bury the map. A far spot's lead shows the spot's size
 * there instead, faded while a pin of its spot is hovered or this pin is.
 */
export function SavedPlacePin({
  pin,
  active,
  scale,
  spot,
  tiles,
}: MapPinProps) {
  const env = useMapMarkEnv(tiles);
  if (env === null) return null;
  const mark = savedPlaceMark({ pin, scale }, env);
  if (mark.kind === "pending") return null;
  const far = scale === "far";
  const name = pin.label ?? "Saved place";
  return (
    <span
      role="img"
      aria-label={name}
      className={cn(
        "group/pin relative block cursor-pointer",
        hoverRevealGroup,
      )}
      style={{ width: mark.width, height: mark.height }}
    >
      <MapMarkImage
        mark={mark}
        className={cn(
          "transition-transform",
          far
            ? active
              ? "scale-[1.3]"
              : "group-hover/pin:scale-125"
            : active
              ? "scale-[1.18]"
              : "group-hover/pin:-translate-y-0.5 group-hover/pin:scale-105",
        )}
        style={{ transformOrigin: `${mark.anchor.x}px ${mark.anchor.y}px` }}
      />
      {spot === undefined ? null : (
        <Beside
          mark={mark}
          className={cn(
            "transition-opacity group-hover/pin:opacity-0",
            (spot.hushed || active) && "opacity-0",
          )}
          decorative
        >
          <MapLabel tiles={tiles}>{spot.count}</MapLabel>
        </Beside>
      )}
      <Name label={pin.label} active={active} tiles={tiles} mark={mark} />
    </span>
  );
}

/** Text beside the mark, at its `labelAt`. */
function Beside({
  mark,
  className,
  decorative,
  children,
}: {
  mark: MapMark;
  className?: string;
  decorative?: boolean;
  children: ReactNode;
}) {
  return (
    <Placed
      x={{ start: mark.labelAt.x }}
      y={{ center: mark.labelAt.centerY }}
      decorative={decorative}
      className={cn("max-w-48 whitespace-nowrap", className)}
    >
      {children}
    </Placed>
  );
}

/** The place's name: on hover, and always on the selected place. */
function Name({
  label,
  active,
  tiles,
  mark,
}: {
  label: string | undefined;
  active: boolean;
  tiles: MapTileScheme;
  mark: MapMark;
}) {
  if (!label) return null;
  return (
    <Beside mark={mark} className={cn(!active && hoverRevealTarget)}>
      <MapLabel tiles={tiles}>{label}</MapLabel>
    </Beside>
  );
}

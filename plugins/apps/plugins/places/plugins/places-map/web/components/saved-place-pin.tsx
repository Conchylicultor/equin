import type { ReactNode } from "react";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { MapLabel, type MapPinProps } from "@plugins/map/web";
import type { MapTileScheme } from "@plugins/map/core";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { readPlaceVisual, type PlaceVisual } from "../internal/place-visual";
import { DROP_HEAD_PX, PlaceDropHead } from "./place-drop";

/** The drop's head on the map: 0.8× the design size, so a street holds more. */
const PIN_HEAD_PX = 24;

/** How far the tip sits below the head's top: a radius plus the turned corner's reach (√2·r). */
const PIN_TIP_PX = Math.round(PIN_HEAD_PX / 2 + PIN_HEAD_PX / Math.SQRT2);

/** Far out, the round badge a place shrinks to: 0.78× the pin's head. */
const BADGE_PX = Math.round(PIN_HEAD_PX * 0.78);

/** Air between a mark and the text beside it. */
const LABEL_GAP_PX = 4;

/** The soft ellipse the drop's tip stands on. */
const GROUND_SHADOW =
  "radial-gradient(closest-side, rgb(0 0 0 / 0.32), rgb(0 0 0 / 0))";

/** The ground ellipse in head units (8, 33, 14, 6 on the 30px design head). */
const ground = (px: number) => Math.round((px * PIN_HEAD_PX) / DROP_HEAD_PX);

/**
 * A saved place on the map (`GeoMap.Pin` for `saved-place`).
 *
 * Near: the drop pin, anchored by the renderer at its tip. A soft ground shadow
 * sits under the tip; hover lifts the drop and the active one grows from its tip.
 *
 * Far (zoomed out): a small round badge in the same paint, centred on the
 * place — badges overlap, the renderer stacking the better place on top. A
 * spot's lead shows how many places the spot holds beside it, as map text;
 * the count fades while a pin of its spot is hovered (`spot.hushed`) or this
 * pin is, so the hovered name reads alone.
 *
 * Either way the name shows beside the mark as a halo `MapLabel` on hover and
 * while the place is selected — never always-on: at street level the names
 * would bury the map.
 */
export function SavedPlacePin({
  pin,
  active,
  scale,
  spot,
  tiles,
}: MapPinProps) {
  const visual = readPlaceVisual(pin);
  const name = pin.label ?? "Saved place";
  return scale === "far" ? (
    <span
      role="img"
      aria-label={name}
      className={cn(
        "group/pin relative block cursor-pointer",
        hoverRevealGroup,
      )}
      style={{ width: BADGE_PX, height: BADGE_PX }}
    >
      <Layer
        className={cn(
          "transition-transform",
          active ? "scale-[1.3]" : "group-hover/pin:scale-125",
        )}
      >
        <PlaceDropHead visual={visual} shape="disc" sizePx={BADGE_PX} />
      </Layer>
      {spot === undefined ? null : (
        <Beside
          centerY="50%"
          className={cn(
            "transition-opacity group-hover/pin:opacity-0",
            (spot.hushed || active) && "opacity-0",
          )}
          decorative
        >
          <MapLabel tiles={tiles}>{spot.count}</MapLabel>
        </Beside>
      )}
      <Name label={pin.label} active={active} tiles={tiles} centerY="50%" />
    </span>
  ) : (
    <span
      role="img"
      aria-label={name}
      className={cn(
        "group/pin relative block cursor-pointer",
        hoverRevealGroup,
      )}
      style={{ width: PIN_HEAD_PX, height: PIN_TIP_PX }}
    >
      <Placed
        x={{ start: ground(8), size: ground(14) }}
        y={{ start: ground(33), size: ground(6) }}
        decorative
        className={cn(!visual.want && "opacity-60")}
        style={{ background: GROUND_SHADOW }}
      />
      <Layer
        className={cn(
          "origin-bottom transition-transform",
          active
            ? "scale-[1.18]"
            : "group-hover/pin:-translate-y-0.5 group-hover/pin:scale-105",
        )}
      >
        <Head visual={visual} />
        <Name
          label={pin.label}
          active={active}
          tiles={tiles}
          centerY={PIN_HEAD_PX / 2}
        />
      </Layer>
    </span>
  );
}

function Head({ visual }: { visual: PlaceVisual }) {
  return (
    <Placed
      x={{ start: 0, size: PIN_HEAD_PX }}
      y={{ start: 0, size: PIN_HEAD_PX }}
    >
      <PlaceDropHead visual={visual} sizePx={PIN_HEAD_PX} />
    </Placed>
  );
}

/** Text beside the mark, its middle at `centerY` — the head's or the badge's. */
function Beside({
  centerY,
  className,
  decorative,
  children,
}: {
  centerY: number | string;
  className?: string;
  decorative?: boolean;
  children: ReactNode;
}) {
  return (
    <Placed
      x={{ start: `calc(100% + ${LABEL_GAP_PX}px)` }}
      y={{ center: centerY }}
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
  centerY,
}: {
  label: string | undefined;
  active: boolean;
  tiles: MapTileScheme;
  centerY: number | string;
}) {
  if (!label) return null;
  return (
    <Beside centerY={centerY} className={cn(!active && hoverRevealTarget)}>
      <MapLabel tiles={tiles}>{label}</MapLabel>
    </Beside>
  );
}

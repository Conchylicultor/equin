import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { MapLabel, type MapPinProps } from "@plugins/map/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { readPlaceVisual } from "../internal/place-visual";
import { DROP_HEAD_PX, PlaceDropHead } from "./place-drop";

/** Air between the head and its label. */
const LABEL_GAP_PX = 4;

/** The soft ellipse the drop's tip stands on. */
const GROUND_SHADOW =
  "radial-gradient(closest-side, rgb(0 0 0 / 0.32), rgb(0 0 0 / 0))";

/**
 * A saved place on the map (`GeoMap.Pin` for `saved-place`): the drop pin.
 * The renderer anchors it at its bottom centre, the drop's tip (36px below the
 * head's top, √2·15 + 15). A soft ground shadow sits under the tip; hover
 * lifts the drop and the active one grows from its tip. The name shows beside
 * the head as a halo `MapLabel` on hover and while the place is selected —
 * the pin is never told the zoom, so it cannot also show it at street level.
 */
export function SavedPlacePin({ pin, active, tiles }: MapPinProps) {
  const visual = readPlaceVisual(pin);
  return (
    <span
      role="img"
      aria-label={pin.label ?? "Saved place"}
      className={cn(
        "group/pin relative block h-9 w-[30px] cursor-pointer",
        hoverRevealGroup,
      )}
    >
      <Placed
        x={{ start: 8, size: 14 }}
        y={{ start: 33, size: 6 }}
        decorative
        className={cn(visual.status === "todo" && "opacity-60")}
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
        <Placed
          x={{ start: 0, size: DROP_HEAD_PX }}
          y={{ start: 0, size: DROP_HEAD_PX }}
        >
          <PlaceDropHead visual={visual} />
        </Placed>
        {pin.label ? (
          <Placed
            x={{ start: `calc(100% + ${LABEL_GAP_PX}px)` }}
            y={{ center: DROP_HEAD_PX / 2 }}
            className={cn(
              "max-w-48 whitespace-nowrap",
              !active && hoverRevealTarget,
            )}
          >
            <MapLabel tiles={tiles}>{pin.label}</MapLabel>
          </Placed>
        ) : null}
      </Layer>
    </span>
  );
}

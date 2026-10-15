import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import type { MapPinProps } from "../slots";
import { MapLabel } from "./map-label";

/** Air between the dot and its spot's count. */
const COUNT_GAP_PX = 4;

/**
 * The pin of a type nobody claimed: a neutral dot in the theme's primary tone.
 * Plain on purpose — a type's owner contributes its real look through
 * `GeoMap.Pin`, and this only guarantees an unclaimed pin is still visible.
 * A dot is round, so it reads the same near and far; as a spot's lead it draws
 * the spot's size beside it.
 */
export function DefaultPin({ pin, active, scale, spot, tiles }: MapPinProps) {
  return (
    <span className="relative block">
      <span
        role="img"
        aria-label={pin.label ?? "Map pin"}
        title={pin.label}
        className={cn(
          "block rounded-full border-2 border-background bg-primary shadow-md transition-transform",
          active ? "size-5 scale-110" : scale === "far" ? "size-3" : "size-4",
        )}
      />
      {spot === undefined ? null : (
        <Placed
          x={{ start: `calc(100% + ${COUNT_GAP_PX}px)` }}
          y={{ center: "50%" }}
          decorative
          className={cn("transition-opacity", spot.hushed && "opacity-0")}
        >
          <MapLabel tiles={tiles}>{spot.count}</MapLabel>
        </Placed>
      )}
    </span>
  );
}

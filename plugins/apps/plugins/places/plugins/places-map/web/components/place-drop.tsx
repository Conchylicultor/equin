import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { PlaceVisual } from "../internal/place-visual";
import { PALE_WASH, dropFill, washInk } from "../internal/pin-paint";

/** The drop's head: a 30px square with three round corners, turned −45°. */
export const DROP_HEAD_PX = 30;

/**
 * Keeps a white icon readable where two slices of a multi-colour head meet.
 * A single colour needs none: the icon sits on one flat fill.
 */
const MULTI_ICON_SHADOW =
  "drop-shadow(0 0 1.5px rgb(0 0 0 / 0.45)) drop-shadow(0 1px 1px rgb(0 0 0 / 0.25))";

/**
 * The head of a saved place's drop pin, filling its (30px square) box: the
 * place's tag colours as slices (one colour solid), a 2px white outline, and
 * its Material icon straight on the fill — white for a place marked Want to
 * go, else the same slices washed pale with the icon in a darker shade of the
 * main colour (Been or not: the map reads as what is still to do).
 * Shared by the map pin, the legend and the place card's hero.
 *
 * The colours are user data (tag hexes), so the fill is painted through
 * `style`; the geometry is the map-layer place pin's (`page/place/map-layer`).
 */
export function PlaceDropHead({ visual }: { visual: PlaceVisual }) {
  const pale = !visual.want;
  const fill = dropFill(visual.colors);
  return (
    <>
      {/* A teardrop is a circle with one square corner, turned 45° so that
          corner becomes the tip. */}
      <Layer
        className="-rotate-45 rounded-full rounded-bl-none border-2 border-categorical-foreground shadow-md"
        style={{ background: pale ? `${PALE_WASH}, ${fill}` : fill }}
      />
      <Center className="relative size-full">
        <Icon
          icon={visual.icon}
          active
          className={cn(pale ? "size-[17px]" : "size-[18px]")}
          style={
            pale
              ? { color: washInk(visual.mainColor) }
              : {
                  color: "white",
                  filter:
                    visual.colors.length > 1 ? MULTI_ICON_SHADOW : undefined,
                }
          }
        />
      </Center>
    </>
  );
}

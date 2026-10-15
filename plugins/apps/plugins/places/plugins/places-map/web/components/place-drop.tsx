import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { PlaceVisual } from "../internal/place-visual";
import { PALE_WASH, dropFill, washInk } from "../internal/pin-paint";

/**
 * The drop's head at its design size: a 30px square with three round corners,
 * turned −45°. The legend and the place card draw it at this size; the map pin
 * draws it smaller (`saved-place-pin`), its icon scaled with it.
 */
export const DROP_HEAD_PX = 30;

/** The icon's size on a head of {@link DROP_HEAD_PX}: a white icon, a washed one. */
const ICON_PX = { solid: 18, pale: 17 } as const;

/** `drop`: the pin's head (one square corner for the tip). `disc`: a round badge. */
export type PlaceHeadShape = "drop" | "disc";

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
export function PlaceDropHead({
  visual,
  shape = "drop",
  sizePx = DROP_HEAD_PX,
}: {
  visual: PlaceVisual;
  shape?: PlaceHeadShape;
  /** The box the head fills, in px; the icon scales with it. */
  sizePx?: number;
}) {
  const pale = !visual.want;
  const fill = dropFill(visual.colors);
  const iconPx = Math.round(
    ((pale ? ICON_PX.pale : ICON_PX.solid) * sizePx) / DROP_HEAD_PX,
  );
  return (
    <>
      {/* A teardrop is a circle with one square corner, turned 45° so that
          corner becomes the tip. The disc keeps the turn, so its slices start
          at the top exactly as the drop's do. */}
      <Layer
        className={cn(
          "-rotate-45 rounded-full border-2 border-categorical-foreground shadow-md",
          shape === "drop" && "rounded-bl-none",
        )}
        style={{ background: pale ? `${PALE_WASH}, ${fill}` : fill }}
      />
      <Center className="relative size-full">
        <Icon
          icon={visual.icon}
          active
          style={
            pale
              ? {
                  color: washInk(visual.mainColor),
                  width: iconPx,
                  height: iconPx,
                }
              : {
                  width: iconPx,
                  height: iconPx,
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

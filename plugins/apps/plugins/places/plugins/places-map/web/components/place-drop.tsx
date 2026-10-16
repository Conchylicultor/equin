import { dropHeadSvg } from "@plugins/map/core";
import { useIconMarkup, type IconMarkup } from "@plugins/ui/plugins/icons/web";
import type { PlaceVisual } from "../internal/place-visual";
import { PALE_VEIL_OPACITY, washInk } from "../internal/pin-paint";

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

/** The outline's colour: the categorical palette's foreground (white). */
const DROP_OUTLINE = "var(--categorical-foreground)";

export interface PlaceDropSvgInput {
  visual: PlaceVisual;
  shape: PlaceHeadShape;
  /** The square box the head fills, px; the icon scales with it. */
  sizePx: number;
  /** The icon's markup (`useIconMarkup`); pending draws the head without it. */
  icon: IconMarkup;
  /**
   * Every colour the head paints, as the SVG will hold it: identity in the DOM
   * (an inline SVG resolves `var()` like any element), the map's resolver for
   * a mark (an SVG drawn as an image sees no stylesheet).
   */
  paint: (css: string) => string;
  /** Prefix for the ids the SVG defines — unique per look (`markIdPrefix`). */
  id: string;
}

/**
 * The head of a saved place's drop pin as SVG markup (`dropHeadSvg`): the
 * place's tag colours as slices (one colour solid), a 2px white outline, and
 * its Material icon straight on the fill — white for a place marked Want to
 * go, else the slices washed pale with the icon in a darker shade of the main
 * colour (Been or not: the map reads as what is still to do).
 *
 * The ONE drawing of the head: the map's sprite of a pin, the pin lifted into
 * the DOM, the legend and the place card's hero all draw this markup.
 */
export function placeDropSvg({
  visual,
  shape,
  sizePx,
  icon,
  paint,
  id,
}: PlaceDropSvgInput): string {
  const pale = !visual.want;
  return dropHeadSvg({
    shape,
    sizePx,
    fills: visual.colors.map(paint),
    ...(pale ? { veil: PALE_VEIL_OPACITY } : {}),
    ring: paint(DROP_OUTLINE),
    ...(icon.kind === "pending"
      ? {}
      : {
          icon: {
            markup: icon,
            sizePx: Math.round(
              ((pale ? ICON_PX.pale : ICON_PX.solid) * sizePx) / DROP_HEAD_PX,
            ),
            ink: paint(pale ? washInk(visual.mainColor) : "white"),
            shadow: !pale && visual.colors.length > 1,
          },
        }),
    id,
  });
}

/**
 * The head of a saved place, drawn in the DOM at `sizePx` (filling its box):
 * {@link placeDropSvg} inline, in this scope's icon style. For the legend and
 * the place card; the map draws the same markup through its mark.
 */
export function PlaceDropHead({
  visual,
  shape = "drop",
  sizePx = DROP_HEAD_PX,
}: {
  visual: PlaceVisual;
  shape?: PlaceHeadShape;
  sizePx?: number;
}) {
  const icon = useIconMarkup()(visual.icon, { active: true });
  // The ids depend on the shape and size only, as do the definitions behind
  // them: two heads of one shape and size define identical filters.
  const markup = placeDropSvg({
    visual,
    shape,
    sizePx,
    icon,
    paint: (css) => css,
    id: `pdh-${shape}-${sizePx}`,
  });
  return (
    <svg
      aria-hidden
      width={sizePx}
      height={sizePx}
      viewBox={`0 0 ${sizePx} ${sizePx}`}
      overflow="visible"
      className="block"
      // Built above from the place's colours (escaped by dropHeadSvg) and the
      // icon sprites' own symbols — never user markup.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

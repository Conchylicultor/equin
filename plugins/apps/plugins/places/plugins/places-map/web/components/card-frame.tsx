import type {
  ComponentProps,
  CSSProperties,
  ElementType,
  ReactNode,
} from "react";
import { clipClasses } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { cardWidthProps } from "./place-photos";

/** A floating card's width — the screen also reads it, to keep pins out from under it. */
export const PLACE_CARD_WIDTH = "340px";

/** The side panel's width — its list, its gallery, and a card drilled into it. */
export const PANEL_WIDTH = "372px";

/**
 * Where a place's card is drawn:
 *
 * - `floating` — its own overlay card on the right of the map, closed by its
 *   Close button (the side panel is hidden);
 * - `panel` — drilled into the side panel, in the panel's own card: `back`
 *   leads it (the way back to the list it was opened from), and there is no
 *   Close — Back is it.
 */
export type CardFrame =
  { kind: "floating" } | { kind: "panel"; back: ReactNode };

function OverlayCard(props: Omit<ComponentProps<typeof Surface>, "level">) {
  return <Surface level="overlay" {...props} />;
}

/**
 * The `Column` props a card is laid out with in its frame: floating, its own
 * overlay surface as tall as its content; in the panel, the panel's card is
 * the surface and the card fills it under its Back line.
 *
 * `photos` is the card's photos panel, when open: its header (Back to the
 * card) replaces the frame's own. In EVERY frame the card glides from its
 * frame's width to the photos panel's (`cardWidthProps`: one element, so the
 * width animates) — derived here, once, so no frame can draw a card that
 * jumps. Drilled into the side panel, the panel's card hugs it and widens
 * with it (leftwards: the panel is pinned to the right edge). The map's
 * uncovered area keeps the resting width, like the floating card's: the
 * photos panel is a transient overlay, and re-measuring would move the
 * camera's padding under the user while they browse photos.
 */
export function cardColumnProps(
  frame: CardFrame,
  photos: { header: ReactNode } | null,
): {
  as?: ElementType;
  fill?: boolean;
  header?: ReactNode;
  className: string;
  style: CSSProperties;
} {
  const clip = clipClasses({ axis: "both", fill: false });
  const width = cardWidthProps(
    frame.kind === "floating" ? PLACE_CARD_WIDTH : PANEL_WIDTH,
    photos !== null,
  );
  if (frame.kind === "floating") {
    return {
      as: OverlayCard,
      ...(photos === null ? {} : { header: photos.header }),
      className: cn("pointer-events-auto max-h-full", clip, width.className),
      style: width.style,
    };
  }
  return {
    fill: true,
    header: photos === null ? frame.back : photos.header,
    className: cn(clip, width.className),
    style: width.style,
  };
}

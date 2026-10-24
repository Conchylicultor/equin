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
 * card) replaces the frame's own. Floating, the card glides from its width to
 * the photos panel's (`cardWidthProps`: one element, so the width animates).
 * Drilled into the side panel it keeps the panel's width — the panel is a
 * fixed column the map's uncovered area and the pins' padding are measured
 * against, so the photos lay out inside it rather than widening it.
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
  if (frame.kind === "floating") {
    const width = cardWidthProps(PLACE_CARD_WIDTH, photos !== null);
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
    className: clip,
    style: { width: PANEL_WIDTH },
  };
}

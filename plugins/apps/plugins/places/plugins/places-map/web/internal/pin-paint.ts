// The saved-place pin's paint, as data: CSS background strings built from the
// place's tag colours. Pure so the slice geometry is unit-tested; the pin
// components only place what these return.

import { NEUTRAL_PLACE_COLOR } from "@plugins/apps/plugins/places/plugins/places-core/core";

/** A colour and its share of a ring. */
export type ColorWeight = readonly [color: string, weight: number];

/**
 * A conic gradient of hard-edged slices, each `weight / total` of the turn,
 * starting `fromDeg` clockwise from the top.
 */
export function conicSlices(
  entries: readonly ColorWeight[],
  fromDeg = 0,
): string {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let at = 0;
  const stops = entries.map(([color, w]) => {
    const start = at;
    at += (w / total) * 360;
    return `${color} ${round(start)}deg ${round(at)}deg`;
  });
  return `conic-gradient(from ${fromDeg}deg, ${stops.join(", ")})`;
}

function round(deg: number): number {
  return Math.round(deg * 100) / 100;
}

/**
 * The drop's fill: one colour solid, several as equal slices. The head is a
 * square turned −45°, so the slices start at 45° to begin at the visual top.
 */
export function dropFill(colors: readonly string[]): string {
  if (colors.length === 0) throw new Error("dropFill: no colour");
  if (colors.length === 1) return colors[0]!;
  return conicSlices(
    colors.map((c) => [c, 1] as const),
    45,
  );
}

/**
 * The head of a place not marked Want to go: the same slices washed pale — a
 * 78% white veil over the fill, not a white disc — so the colours still read
 * at a glance.
 */
export const PALE_WASH =
  "linear-gradient(rgb(255 255 255 / 0.78), rgb(255 255 255 / 0.78))";

/** The white veil's opacity over a pale head — {@link PALE_WASH}'s, as a number for SVG. */
export const PALE_VEIL_OPACITY = 0.78;

/** The icon ink on a washed (pale) head: the main colour, darkened. */
export function washInk(mainColor: string): string {
  return `color-mix(in srgb, ${mainColor} 72%, black)`;
}

/**
 * A colour drained to its grey — same lightness, no chroma — for a place Google
 * says is permanently closed. Every surface paints from the greyed colours, so
 * the pin, the hero and the glyph all go grey together.
 */
export function greyed(color: string): string {
  return `oklch(from ${color} l 0 h)`;
}

/**
 * The colours a place is painted in: its tag colours (the neutral one when it
 * has none), greyed when Google says it is permanently closed. Never empty.
 */
export function placeColors(
  tagColors: readonly string[],
  closed: boolean,
): string[] {
  const tinted = tagColors.length > 0 ? [...tagColors] : [NEUTRAL_PLACE_COLOR];
  return closed ? tinted.map(greyed) : tinted;
}

/** The pale tint of a colour — a place's hero or gallery cover behind its icon. */
export function paleTint(color: string): string {
  return `color-mix(in srgb, ${color} 22%, white)`;
}

import { defineTokenGroup } from "@plugins/ui/plugins/theme-engine/core";

/**
 * The spend breakdown's colours: `spend-1` … `spend-5` paint a level's parts
 * in order (never cycled — a level holds five at most), `spend-rest` the
 * folded remainder, a tinted grey that never reads as a sixth part.
 *
 * Validated as a set on a dark surface: adjacent colours stay apart under
 * colour-vision deficiency (ΔE ≥ 9.4) at one lightness band, so no part
 * shouts over another. Its own group rather than the categorical slots,
 * because the breakdown's parts sit side by side in one thin bar, where the
 * general series colours (tuned for chart lines) are too far apart in
 * lightness.
 */
export const spendPaletteGroup = defineTokenGroup("spend-palette", {
  "spend-1": { default: "oklch(0.58 0.11 245)", label: "Part 1" },
  "spend-2": { default: "oklch(0.665 0.11 80)", label: "Part 2" },
  "spend-3": { default: "oklch(0.55 0.10 165)", label: "Part 3" },
  "spend-4": { default: "oklch(0.66 0.11 305)", label: "Part 4" },
  "spend-5": { default: "oklch(0.56 0.13 30)", label: "Part 5" },
  "spend-rest": {
    default: "oklch(0.78 0.012 250)",
    darkDefault: "oklch(0.42 0.014 250)",
    label: "The rest",
  },
});

/** One spend colour token. */
export type SpendPaletteToken = keyof typeof spendPaletteGroup.schema;

/** The colour of a level's `index`-th part (0-based, at most 4). */
export function spendPartToken(index: number): SpendPaletteToken {
  if (!Number.isInteger(index) || index < 0 || index > 4)
    throw new Error(`spend palette: no colour for part ${index}`);
  return `spend-${index + 1}` as SpendPaletteToken;
}

/** Pure: the CSS colour a token paints. */
export function spendTokenFill(token: SpendPaletteToken): string {
  return `var(--${token})`;
}

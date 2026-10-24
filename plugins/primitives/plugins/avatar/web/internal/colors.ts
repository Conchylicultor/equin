import {
  AVATAR_COLOR_NAMES,
  type AvatarColor,
  avatarColorPick,
  type AvatarColorPick,
} from "../../core";

// Three paints per colour, both keyed off the categorical palette slot:
// - SOFT (badge presentation): a 15% tint of the slot with the slot as text —
//   light bg + matching dark text in light mode, muted dark bg + light text in
//   dark mode. Keys align with the conversation-category palette.
// - GRADIENT (gradient-tile presentation): the slot darkened, running into the
//   slot — one gradient per slot, no second shade.
// - FLAT (tile presentation): the solid slot under the `categorical-foreground`
//   glyph token, in two shades per slot — shade 1 is `bg-categorical-N-lift`,
//   the slot lifted 0.13 in OKLCH lightness (derived once in ui-kit's app.css) —
//   so the eight automatic slots give sixteen tile colours.
//
// Every class is a literal string so Tailwind's scanner sees it.

export const AVATAR_COLORS = {
  sky: "bg-categorical-1/15 text-categorical-1",
  emerald: "bg-categorical-2/15 text-categorical-2",
  amber: "bg-categorical-3/15 text-categorical-3",
  rose: "bg-categorical-4/15 text-categorical-4",
  violet: "bg-categorical-5/15 text-categorical-5",
  indigo: "bg-categorical-6/15 text-categorical-6",
  teal: "bg-categorical-7/15 text-categorical-7",
  pink: "bg-categorical-8/15 text-categorical-8",
  orange: "bg-categorical-9/15 text-categorical-9",
  slate: "bg-categorical-10/15 text-categorical-10",
} as const satisfies Record<AvatarColor, string>;

/** The flat tile fill per slot: `[shade 0, shade 1]`. */
const AVATAR_FLAT_COLORS = {
  sky: [
    "bg-categorical-1 text-categorical-foreground",
    "bg-categorical-1-lift text-categorical-foreground",
  ],
  emerald: [
    "bg-categorical-2 text-categorical-foreground",
    "bg-categorical-2-lift text-categorical-foreground",
  ],
  amber: [
    "bg-categorical-3 text-categorical-foreground",
    "bg-categorical-3-lift text-categorical-foreground",
  ],
  rose: [
    "bg-categorical-4 text-categorical-foreground",
    "bg-categorical-4-lift text-categorical-foreground",
  ],
  violet: [
    "bg-categorical-5 text-categorical-foreground",
    "bg-categorical-5-lift text-categorical-foreground",
  ],
  indigo: [
    "bg-categorical-6 text-categorical-foreground",
    "bg-categorical-6-lift text-categorical-foreground",
  ],
  teal: [
    "bg-categorical-7 text-categorical-foreground",
    "bg-categorical-7-lift text-categorical-foreground",
  ],
  pink: [
    "bg-categorical-8 text-categorical-foreground",
    "bg-categorical-8-lift text-categorical-foreground",
  ],
  orange: [
    "bg-categorical-9 text-categorical-foreground",
    "bg-categorical-9-lift text-categorical-foreground",
  ],
  slate: [
    "bg-categorical-10 text-categorical-foreground",
    "bg-categorical-10-lift text-categorical-foreground",
  ],
} as const satisfies Record<AvatarColor, readonly [string, string]>;

/**
 * The gradient tile fill per slot: the slot darkened 0.28 in OKLCH lightness
 * (`-deep`, derived in ui-kit's app.css) running into the slot at 140°, under
 * the categorical-foreground glyph. Interpolated in sRGB, like a CSS
 * `linear-gradient` with no colour space.
 */
const AVATAR_GRADIENT_COLORS = {
  sky: "bg-linear-140/srgb from-categorical-1-deep to-categorical-1 text-categorical-foreground",
  emerald:
    "bg-linear-140/srgb from-categorical-2-deep to-categorical-2 text-categorical-foreground",
  amber:
    "bg-linear-140/srgb from-categorical-3-deep to-categorical-3 text-categorical-foreground",
  rose: "bg-linear-140/srgb from-categorical-4-deep to-categorical-4 text-categorical-foreground",
  violet:
    "bg-linear-140/srgb from-categorical-5-deep to-categorical-5 text-categorical-foreground",
  indigo:
    "bg-linear-140/srgb from-categorical-6-deep to-categorical-6 text-categorical-foreground",
  teal: "bg-linear-140/srgb from-categorical-7-deep to-categorical-7 text-categorical-foreground",
  pink: "bg-linear-140/srgb from-categorical-8-deep to-categorical-8 text-categorical-foreground",
  orange:
    "bg-linear-140/srgb from-categorical-9-deep to-categorical-9 text-categorical-foreground",
  slate:
    "bg-linear-140/srgb from-categorical-10-deep to-categorical-10 text-categorical-foreground",
} as const satisfies Record<AvatarColor, string>;

export const AVATAR_COLOR_KEYS: readonly AvatarColor[] = AVATAR_COLOR_NAMES;

/** Badge paint: the soft tint class for a pick (`bg-muted` for none). */
export function avatarSoftClass(pick: AvatarColorPick | null): string {
  return pick ? AVATAR_COLORS[pick.slot] : "bg-muted";
}

/** Tile paint: the flat fill + categorical-foreground glyph class for a pick. */
export function avatarFlatClass(pick: AvatarColorPick | null): string {
  return pick
    ? AVATAR_FLAT_COLORS[pick.slot][pick.shade]
    : "bg-muted text-foreground";
}

/**
 * The paint for a `fill` — a colour from outside the categorical palette (a
 * domain's own token, e.g. `var(--place-food)`), set on the box as
 * `--avatar-fill`. Same two presentations as a slot: the soft badge is a 15%
 * tint with the fill as text, the flat tile the solid fill under the
 * categorical-foreground glyph.
 */
export const AVATAR_FILL_SOFT_CLASS =
  "bg-[color-mix(in_oklab,var(--avatar-fill)_15%,transparent)] text-[var(--avatar-fill)]";
export const AVATAR_FILL_FLAT_CLASS =
  "bg-[var(--avatar-fill)] text-categorical-foreground";

/** The soft (badge) class for a colour / fallback key — `avatarSoftClass(avatarColorPick(…))`. */
export function avatarColorClass(
  color: string | null | undefined,
  fallbackKey?: string,
): string {
  return avatarSoftClass(avatarColorPick(color, fallbackKey));
}

/** Gradient tile paint: the deep → slot gradient + categorical-foreground glyph class for a pick. */
export function avatarGradientClass(pick: AvatarColorPick | null): string {
  return pick ? AVATAR_GRADIENT_COLORS[pick.slot] : "bg-muted text-foreground";
}

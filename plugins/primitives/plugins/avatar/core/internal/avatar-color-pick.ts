import { AVATAR_COLOR_NAMES, type AvatarColor } from "./avatar-color";

// The colour an avatar paints, as data: which palette slot and which tile shade.
// Runtime-agnostic, so a non-web painter (the server's app-icon PNGs) picks the
// exact colour the web tile paints for the same app.

const AUTO_ORDER: readonly AvatarColor[] = [
  "sky",
  "emerald",
  "amber",
  "rose",
  "violet",
  "indigo",
  "teal",
  "pink",
];

function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return h >>> 0;
}

function isAvatarColor(color: string): color is AvatarColor {
  return (AVATAR_COLOR_NAMES as readonly string[]).includes(color);
}

/** Which palette slot an avatar paints, and which of its two tile shades. */
export interface AvatarColorPick {
  slot: AvatarColor;
  /** Tile shade: 0 = the slot, 1 = the slot lifted in lightness. The soft
   *  (badge) paint has one shade per slot and ignores this. */
  shade: 0 | 1;
}

/**
 * The colour an avatar paints. An explicit known `color` wins (shade 0);
 * otherwise `fallbackKey` hashes to one of the eight automatic slots
 * (`hash % 8`) and a shade (`floor(hash / 8) % 2`). `null` = no colour: the
 * neutral muted box.
 */
export function avatarColorPick(
  color: string | null | undefined,
  fallbackKey?: string,
): AvatarColorPick | null {
  if (color && isAvatarColor(color)) return { slot: color, shade: 0 };
  if (!fallbackKey) return null;
  const h = hash(fallbackKey);
  return {
    slot: AUTO_ORDER[h % AUTO_ORDER.length]!,
    shade: Math.floor(h / AUTO_ORDER.length) % 2 === 0 ? 0 : 1,
  };
}

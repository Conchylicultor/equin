/**
 * The player's measures, as the prototype names them
 * (`proto-1793924689-zwfacl`, its `slim` size — the one shipped). Kept as
 * named constants, not a size knob: the prototype also designs `regular`
 * (row 40, button 36, icon 22, pill 48) and `slimmer` (row 28, button 26,
 * icon 18, pill 36); a size option is these numbers switched as one set.
 *
 * The CSS (`media-player.css`) spells the same numbers; the ones the code
 * computes with live here.
 */
export const SLIM = {
  /** The button row; the pill is the row + 8px (3px padding, 1px border). */
  row: 34,
  /** A pill button's square. */
  button: 30,
  /** The space between the pill and anything floating above it. */
  gap: 6,
  /** The settings panel's scale: the pill's height over the regular 48px. */
  k: 0.875,
} as const;

/** How long the controls stay up after the pointer last moved, while playing. */
export const IDLE_MS = 2000;
/** The volume capsule stays open this long after the pointer leaves it. */
export const VOLUME_CLOSE_MS = 180;
/** A wheel over the speed dial settles onto the step this long after it stops. */
export const DIAL_WHEEL_SETTLE_MS = 120;
/** The size the picture-in-picture window opens at (its height follows the video). */
export const PIP_WIDTH = 560;
/** A pill button's tooltip waits this long under the pointer. */
export const TOOLTIP_DELAY_MS = 350;

/** The preview frame's size: a quarter of the player's width, in bounds. */
const PREVIEW_MIN_W = 96;
const PREVIEW_MAX_W = 192;
/** …and never taller than this share of the player (a short or portrait video). */
const PREVIEW_MAX_H_SHARE = 0.4;

/**
 * The preview frame's size inside a `width × height` player for a video of
 * `aspect` (width over height), or null while the aspect is not known yet.
 */
export function previewSize(
  aspect: number,
  width: number,
  height: number,
): { width: number; height: number } | null {
  if (!(aspect > 0)) return null;
  let w = Math.min(PREVIEW_MAX_W, Math.max(PREVIEW_MIN_W, width / 4));
  let h = w / aspect;
  const maxH = height * PREVIEW_MAX_H_SHARE;
  if (h > maxH) {
    h = maxH;
    w = h * aspect;
  }
  return { width: Math.round(w), height: Math.round(h) };
}

// ── Touch (`proto-1794361798-f9dak8`) ───────────────────────────────────

/** The media query a touch-first screen answers: no hover, a coarse pointer. */
export const TOUCH_QUERY = "(hover: none) and (pointer: coarse)";
/**
 * How long the touch controls stay up after the last tap, while playing.
 * Shorter than YouTube's ~3 s on purpose: the picture is the point on a small
 * screen, and every tap on the chrome restarts the clock.
 */
export const TOUCH_HIDE_MS = 1500;
/** One centre ± button, or one tap of a side double-tap: media seconds. */
export const TOUCH_SKIP_SECONDS = 10;
/** A second tap on the same side within this is a double-tap (a seek), not two taps. */
export const DOUBLE_TAP_MS = 280;
/** Once a side seek runs, each tap on that side within this seeks again. */
export const SEEK_RUN_MS = 750;
/** Where a side starts: a tap left of this fraction of the width is the left side… */
export const SIDE_LEFT = 0.38;
/** …and right of this one the right side; between them, the middle. */
export const SIDE_RIGHT = 0.62;

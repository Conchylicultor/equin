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

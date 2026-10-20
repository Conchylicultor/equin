/**
 * Where the immersive player's floating chrome sits over the notes, in px —
 * the mockup's measurements (proto-1792113547-2qr6g7), spelled once so the
 * display, the progression capsule and the section dock agree on them.
 *
 * The notes fill the window; the chrome floats over them. Only the section
 * dock takes room: the display (and the capsule centred over it) keeps to the
 * part of the window the dock does not cover, so an open panel sits BESIDE the
 * notes, never over them.
 */

/** The header band: back, the song's title and the toolbar pill. */
export const HEADER_HEIGHT = 58;

/** The gap between the floating chrome and the window's edges. */
export const EDGE = 14;

/** The section rail: its width, and the room it reserves at the right edge. */
export const RAIL_WIDTH = 50;
export const RAIL_RESERVE = 72;
/** One section icon button of the rail (square). */
export const RAIL_BUTTON = 40;

/** The expanded section panel: its width, and the room it reserves. */
export const PANEL_WIDTH = 382;
export const PANEL_RESERVE = 408;

/** The panel starts under the toolbar pill and stops short of the bottom. */
export const PANEL_TOP = 62;
export const PANEL_BOTTOM = 12;

/** The progression capsule: its top, and its widest. */
export const CAPSULE_TOP = 64;
export const CAPSULE_MAX_WIDTH = 980;
/** The capsule's margin to the notes' edges once it is narrower than its max. */
export const CAPSULE_MARGIN = 16;

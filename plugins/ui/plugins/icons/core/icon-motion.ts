/**
 * The closed vocabulary of icon motions: what a moving part of an app-drawn
 * glyph may do when the control holding it is hovered inside a motion region
 * (`IconMotionRegion`, icons web). Each is one keyframe set in the icons
 * stylesheet (`web/internal/icon-motion.css`), ~0.5 s, ending at rest or at a
 * symmetric pose.
 *
 * A glyph body marks a moving part with `data-motion="<kind>"`, optionally
 * `data-motion-delay="<ms>"` (a stagger) and `data-motion-origin="<x> <y>"`
 * (the transform origin, in the 24-unit grid; otherwise the part's own box
 * centre). `defineIconFamily` validates all three, so an unknown kind fails as
 * the family module loads.
 */
export const ICON_MOTIONS = [
  // Directional nudges: out by 2 units and back.
  "nudge-up",
  "nudge-down",
  "nudge-left",
  "nudge-right",
  // A quarter turn clockwise (a square, a gear tooth: ends looking the same).
  "turn",
  // Swell to 116% and back.
  "pop",
  // The stroke draws itself from its start (`pathLength="1"`, added by the definition).
  "draw",
  // Off / on twice (a cursor).
  "blink",
  // Squash vertically and back (an eye closing).
  "blink-y",
  // Up by 2 units and back.
  "bob",
  // Appears, holds, fades (a typed character) — invisible at rest.
  "type",
  // A small circling sweep (a magnifier).
  "scan",
  // Rock left, right, settle.
  "tilt",
  // A quick wobble (a pencil writing).
  "scribble",
  // Shake side to side with a slight rotation (a bell, a trash can).
  "shake",
  // Down-right by 1.5 units and back (a card sliding).
  "slide",
  // Rotate out to the left / right and back (fanning parts).
  "splay-l",
  "splay-r",
  // Two halves of a link moving apart diagonally and back.
  "link-a",
  "link-b",
  // A lid or a door opening to the left / right and back.
  "open-l",
  "open-r",
  // Squeeze horizontally and back.
  "squeeze",
  // Grow up from the bottom edge (a bar of a chart).
  "grow",
  // A hop with a tilt.
  "hop",
  // A small hop, no tilt.
  "hop-small",
  // Drift right, overshoot back.
  "drift",
  // A half turn (an hourglass).
  "flip",
  // A full turn anticlockwise (history, refresh).
  "rewind",
  // A full turn clockwise (refresh, a clock hand, a progress wedge).
  "spin",
  // Rise and fade, reappear from below (a speech bubble).
  "bubble",
  // Up-right and back (a rocket, an arrow out).
  "launch",
  // Flicker vertically (a flame).
  "flicker",
  // Fade in from dim (a bulb lighting).
  "light",
  // A turn of 72° with a swell (a star).
  "twinkle",
  // A turn of 90° with a swell (a sparkle).
  "spark",
] as const;

export type IconMotion = (typeof ICON_MOTIONS)[number];

const MOTIONS: ReadonlySet<string> = new Set(ICON_MOTIONS);

export function isIconMotion(value: string): value is IconMotion {
  return MOTIONS.has(value);
}

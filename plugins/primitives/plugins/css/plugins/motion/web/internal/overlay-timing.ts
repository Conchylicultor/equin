/**
 * The overlay token group's motion, read where it applies: the same
 * `--overlay-enter-*` variables `OverlayPanel`'s `overlay-enter` and
 * `Surface`'s `surface-enter` keyframes read (app.css), so a script-driven
 * enter or exit moves exactly like a CSS one and follows the theme of the
 * scope the element sits in.
 */
export interface OverlayTiming {
  /** The enter's duration, in ms (0 = instant). */
  enterMs: number;
  easing: string;
  /** The scale an entering surface starts from (and a leaving one ends at). */
  scale: string;
}

/** An exit is the enter played back, in three quarters of its time — the
 *  ratio `overlay-exit` uses. */
export const EXIT_RATIO = 0.75;

export function overlayTiming(el: Element): OverlayTiming {
  const style = getComputedStyle(el);
  return {
    enterMs: parseDuration(style.getPropertyValue("--overlay-enter-duration")),
    easing:
      style.getPropertyValue("--overlay-enter-easing").trim() || "ease-out",
    scale: style.getPropertyValue("--overlay-enter-scale").trim() || "1",
  };
}

/** A CSS `<time>` (`140ms`, `0.2s`) in ms; anything else (unset — a test
 *  document without the theme) is 0: no motion. */
function parseDuration(raw: string): number {
  const value = raw.trim();
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  return value.endsWith("ms") ? n : value.endsWith("s") ? n * 1000 : 0;
}

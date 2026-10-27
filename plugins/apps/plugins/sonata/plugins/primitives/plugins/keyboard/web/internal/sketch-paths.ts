/**
 * The pen. Pure, framework-free geometry for the hand-drawn key skin: a seeded
 * random source, a key outline that wobbles, and the loose rule the keys hang
 * from. No React, no DOM, no colours — just path strings.
 *
 * Ported from the prototype at `~/.equin/apps/prototypes/sketch-roll`
 * (`keyRng` / `drawnKeyPath` / `drawnLine`), which is where the numbers were
 * settled. The arithmetic is unchanged; only the 8-positional-number signature
 * became an options object.
 *
 * **Seeded purely from the pitch.** A key's shape is therefore stable across
 * every re-render, every note-on and every remount, with no ref bookkeeping and
 * no cached-shape state anywhere: the same key always redraws as the same
 * squiggle. That is the whole reason the wobble does not shimmer during
 * playback — and it is why this module is the testable half of the skin.
 */

/** The prototype's LCG — small, fast, and identical run to run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/**
 * A random source belonging to one key. `salt` separates the several
 * independent draws a single key needs (its outline, its overdrawn second
 * outline, the rule) so they wobble differently while both staying pinned to
 * the pitch.
 */
export function keyRng(pitch: number, salt: number): () => number {
  return lcg(((pitch + 1) * 9781 + salt * 6151) >>> 0);
}

/** The key height the prototype's pen constants were tuned against (px). */
const REFERENCE_KEY_HEIGHT = 104;

/**
 * How hard the pen presses at a given key height.
 *
 * The prototype only ever drew one canvas, so it could hardcode both numbers.
 * This primitive renders at the full 88-key roll *and* at an `h-11` readout
 * chip, where the same absolute wobble stops reading as a drawn edge and starts
 * reading as noise — so both the wobble and the stroke weights are derived from
 * the measured key height instead.
 *
 * `scale` is 1 at the reference height and floors at 0.45, so a chip keeps a
 * visible line rather than fading to a hairline.
 */
export interface SketchMetrics {
  /** Peak wobble amplitude, in px. */
  amp: number;
  /** Pen scale (1 at the reference height) — multiplies stroke widths, corner
   *  radii, the cast-shadow blur and its offset. */
  scale: number;
}

export function sketchMetrics(keyHeight: number): SketchMetrics {
  return {
    amp: clamp(keyHeight * 0.02, 0.4, 1.8),
    scale: clamp(keyHeight / REFERENCE_KEY_HEIGHT, 0.45, 1),
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** One key's box plus the pen settings that draw it. */
export interface DrawnKeyOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Anything stable per key — the pitch, or the pitch plus an offset for the
   *  second pass over the same outline. */
  seed: number;
  /** Peak wobble, in px. 0 draws the same shape with a steady hand. */
  amp: number;
  /** Corner radius at the top (tucked under the fallboard — barely eased). */
  topRadius: number;
  /** Corner radius at the front lip facing the player — rounder. */
  bottomRadius: number;
}

/**
 * A rectangle drawn by hand: bowed edges, uneven corners, a squarer top and a
 * rounder front lip — the proportions of a real key, none of the precision.
 */
export function drawnKeyPath({
  x,
  y,
  width,
  height,
  seed,
  amp,
  topRadius,
  bottomRadius,
}: DrawnKeyOptions): string {
  const r = keyRng(seed, 3);
  const j = () => (r() - 0.5) * 2 * amp;
  const bowL = j() * 0.8;
  const bowR = j() * 0.8;
  const x0 = x + j() * 0.5;
  const x1 = x + width + j() * 0.5;
  const yTop = y + j() * 0.4;
  const yBot = y + height + j() * 0.6;
  const tr = topRadius + j() * 0.4;
  const br = bottomRadius + j() * 0.6;
  const f = (n: number) => n.toFixed(2);
  return [
    `M ${f(x0 + tr)} ${f(yTop)}`,
    `Q ${f((x0 + x1) / 2 + j())} ${f(yTop + j() * 0.6)} ${f(x1 - tr)} ${f(yTop)}`,
    `Q ${f(x1)} ${f(yTop)} ${f(x1)} ${f(yTop + tr)}`,
    `Q ${f(x1 + bowR)} ${f(yTop + height / 2)} ${f(x1)} ${f(yBot - br)}`,
    `Q ${f(x1)} ${f(yBot)} ${f(x1 - br)} ${f(yBot)}`,
    `Q ${f((x0 + x1) / 2 + j())} ${f(yBot + j() * 0.7)} ${f(x0 + br)} ${f(yBot)}`,
    `Q ${f(x0)} ${f(yBot)} ${f(x0)} ${f(yBot - br)}`,
    `Q ${f(x0 + bowL)} ${f(yTop + height / 2)} ${f(x0)} ${f(yTop + tr)}`,
    `Q ${f(x0)} ${f(yTop)} ${f(x0 + tr)} ${f(yTop)}`,
    "Z",
  ].join(" ");
}

/**
 * A loose pencil line — the rule the keys hang from, in place of the felt strip
 * the other two skins draw. Sampled every ~90px so a long rule waves rather
 * than buzzing, and a short one still gets its 6 segments.
 */
export function drawnLine(
  x0: number,
  x1: number,
  y: number,
  seed: number,
  amp: number,
): string {
  const r = keyRng(seed, 11);
  const steps = Math.max(6, Math.round((x1 - x0) / 90));
  const f = (n: number) => n.toFixed(2);
  let d = `M ${f(x0)} ${f(y + (r() - 0.5) * amp)}`;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    d += ` L ${f(x0 + (x1 - x0) * t)} ${f(y + (r() - 0.5) * amp * 2)}`;
  }
  return d;
}

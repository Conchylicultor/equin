// The building contract: what an app's building declares (its footprint, the
// spot it likes, its night lights) and how it is drawn (`paint`, `animate`).
// Pure data and canvas functions — no DOM, no React — so a worker can paint one.

/** A 2D context a building or a character paints into: on-screen or offscreen. */
export type Ctx2D =
  CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** An axis-aligned box `[x0, y0, x1, y1]` (x0 ≤ x1, y0 ≤ y1). */
export type Box = readonly [number, number, number, number];

/**
 * Where a building likes to stand — the terrain around a plot. `coast` (the sea
 * within reach), `cape` (sea on many sides), `shore` (by a river or a lake),
 * `harbour` (by the dock or a pier), `hill`, `forest` (at a wood's edge),
 * `square` (on a district square), `lane` (along a street or a road).
 */
export type Setting = (typeof SETTINGS)[number];

/** Every {@link Setting}. */
export const SETTINGS = [
  "coast",
  "cape",
  "shore",
  "harbour",
  "hill",
  "forest",
  "square",
  "lane",
] as const;

/**
 * Coordinates are relative to the door: (0, 0) is the ground at the middle of
 * the front door's threshold, y grows DOWN (up is negative). The player is ~50
 * px tall; a building is ~150–240 px wide and up to ~300 px tall.
 *
 * A plot splits what a building covers at y = -{@link GROUND_BAND}: the GROUND
 * band below it (base, props, shadow) — bands of two plots never touch — and
 * the UPPER part above it (walls, roof, tower), which may rise in front of the
 * ground of the plot behind.
 */
export const GROUND_BAND = 112;

/**
 * What a building covers — DECLARED, never measured at runtime, so placement is
 * a pure function. The footprint test paints every building and checks its ink
 * stays inside (`buildings/core/testing`'s `paintedExtent`). Glows — what is
 * drawn with `globalCompositeOperation = "lighter"` (a lighthouse's beams, a
 * forge's flicker) — are light, not ink: they are not part of it.
 */
export interface Footprint {
  /** The solid base the walker cannot cross: x ∈ [-w/2, w/2], y ∈ [-depth, 0]. */
  readonly w: number;
  readonly depth: number;
  /** Everything painted at y ≥ -GROUND_BAND (base, props, shadow), animation included. */
  readonly ground: Box;
  /** Everything painted above y = -GROUND_BAND, or null when nothing rises that high. */
  readonly upper: Box | null;
}

/** A night glow: `[x, y, radius]`, door-relative. */
export type Light = readonly [number, number, number];

/**
 * A chimney's mouth, door-relative, and the smoke it gives: `puffs` in flight
 * (default 6), `spread` (how far they drift, default 1), `phase` (seconds, so
 * neighbours do not puff in step). Data, not paint: the renderer draws the
 * smoke (`chimneySmoke`), as thick as the app is lived in — a building whose
 * app is never opened stays quiet.
 */
export interface Chimney {
  readonly x: number;
  readonly y: number;
  readonly puffs?: number;
  readonly spread?: number;
  readonly phase?: number;
}

/** What `paint` / `animate` are handed. */
export interface PaintState {
  /** Seconds since the scene started (animate only; 0 for paint). */
  readonly t: number;
  readonly night: boolean;
  readonly dusk: boolean;
  /** The player stands at the door (animate only): door ajar, warm light spilling out. */
  readonly open: boolean;
  /** The app's accent colour, `#rrggbb` (its tile colour). */
  readonly hue: string;
  /** `col` darkened (k < 0) or lightened (k > 0) by |k|, as `rgb(…)`. */
  shade(col: string, k: number): string;
  /** A random stream seeded from the app id: the same app paints the same picture. */
  rnd(): number;
  /** Draws the app's icon glyph, centred on (cx, cy), `size` px tall, in the current fill style. */
  glyph(g: Ctx2D, cx: number, cy: number, size: number): void;
}

export interface BuildingSpec {
  readonly footprint: Footprint;
  /** The spots it likes, first choice first (the coast, a hill…); none: anywhere. */
  readonly setting?: readonly Setting[];
  /**
   * Where its signpost stands, door-relative x (the engine may mirror it to the
   * other side). Omitted: just past the base, `-(w / 2 + 30)`.
   */
  readonly signX?: number;
  readonly lights: readonly Light[];
  /** Its chimney, if it has one: the renderer draws its smoke. */
  readonly chimney?: Chimney;
  /** The static picture: painted once per time of day and cached by the engine. */
  paint(g: Ctx2D, s: PaintState): void;
  /** What moves (a turning sail, a beam, a swing — never chimney smoke: that is `chimney`), drawn every frame over the cached paint. */
  animate?(g: Ctx2D, s: PaintState): void;
}

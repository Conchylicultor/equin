/**
 * The iceberg's geometry, as pure functions of measured numbers: the berg's
 * silhouette, each layer strip's sky or sea, the rows the pieces sit on and an
 * open card's width. Everything DOM lives in `scene.ts`.
 */

/** Below this scene width the page is a phone: the berg widens fast below the waterline so the pieces still share rows. */
export const PHONE = 640;

/** The berg's half-width per layer, as a fraction of `maxHalf`. */
const HW_WIDE = [
  0.02, 0.34, 0.52, 0.64, 0.76, 0.86, 0.93, 0.96, 0.88, 0.5,
] as const;
const HW_PHONE = [
  0.02, 0.66, 0.76, 0.84, 0.9, 0.94, 0.96, 0.97, 0.92, 0.55,
] as const;

export const hwFor = (W: number): readonly number[] =>
  W < PHONE ? HW_PHONE : HW_WIDE;

/** The widest the berg gets on either side of the centre line. */
export const maxHalf = (W: number) => Math.min(W * 0.48, 580);

/** A pill's type size per weight, px. */
export const PIECE_FONT: Record<1 | 2 | 3, number> = {
  3: 21,
  2: 16.5,
  1: 13.5,
};

/** An open card's width when it has no drawing: roughly square-ish text blocks, wider for heavier pieces. */
export const openWidth = (desc: string, weight: number) =>
  Math.round(
    Math.min(300, 80 + 15 * Math.sqrt(desc.length) + (weight - 1) * 16),
  );

/** A seeded PRNG (Park–Miller), so the berg's jitter is the same on every draw. */
function prng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

export type Point = readonly [number, number];

/**
 * The berg's outline: `keys` are `[y, half-width]` down the berg; each span is
 * cut into four jittered steps, mirrored about the centre, closing at `tailY`.
 */
export function bergPoints({
  W,
  M,
  keys,
  tailY,
}: {
  W: number;
  M: number;
  keys: readonly Point[];
  tailY: number;
}): Point[] {
  const cx = W / 2;
  const rnd = prng(99);
  const side = (sign: number) => {
    const pts: Point[] = [];
    for (let k = 0; k < keys.length - 1; k++) {
      const [y0, w0] = keys[k] ?? [0, 0];
      const [y1, w1] = keys[k + 1] ?? [0, 0];
      for (let s = 0; s < 4; s++) {
        const t = s / 4;
        const y = y0 + (y1 - y0) * t;
        const jitter = k === 0 && s === 0 ? 0 : (rnd() - 0.5) * 0.09 * M;
        pts.push([cx + sign * Math.max(4, w0 + (w1 - w0) * t + jitter), y]);
      }
    }
    pts.push([cx + sign * 4, tailY]);
    return pts;
  };
  return [...side(1), ...side(-1).reverse()];
}

export const polyStr = (pts: readonly Point[]) =>
  pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");

/**
 * The y of a depth given in layer units (u = k is the top of layer k, the last
 * unit the berg's end): a colour placed by unit stays on its layer however tall
 * the layers get.
 */
export function unitY(cuts: readonly number[], u: number): number {
  const k = Math.min(Math.floor(u), cuts.length - 2);
  const a = cuts[k] ?? 0;
  const b = cuts[k + 1] ?? a;
  return a + (b - a) * (u - k);
}

/** The sky: a glow of the brand blue over a white-to-ice gradient (the scene's palette, `iceberg.css`). */
const SKY =
  "radial-gradient(820px 460px at 50% 220px, var(--berg-glow-a), var(--berg-glow-b) 50%, transparent 75%), linear-gradient(to bottom, var(--berg-sky-0), var(--berg-sky-1) 60%, var(--berg-sky-2))";

/**
 * Each strip's own sky or sea. Strip 0 is the sky; strip i ≥ 1 is the sea over
 * layer i, its stops given in layer units (the waterline is 1, the end of the
 * berg is n) and placed relative to the strip, stops outside it included, so
 * the strips join into one continuous sea that never depends on how tall the
 * page is.
 */
export function stripBg(i: number, n: number): string {
  if (i === 0) return SKY;
  const stops: readonly (readonly [number, string])[] = [
    [1, "var(--berg-sea-0)"],
    [2, "var(--berg-sea-1)"],
    [1 + (n - 1) * 0.5, "var(--berg-sea-2)"],
    [1 + (n - 1) * 0.78, "var(--berg-sea-3)"],
    [n, "var(--berg-abyss)"],
  ];
  return `linear-gradient(to bottom, ${stops.map(([u, c]) => `${c} ${((u - i) * 100).toFixed(2)}%`).join(", ")})`;
}

/**
 * A layer's row of pieces: as wide as the berg is there (the apps narrower, the
 * abyss wider), and the width it widens to while it holds an open card — 40%
 * wider, never narrower than two drawing cards side by side, and never into the
 * gauge's margin.
 */
export function rowWidths(
  W: number,
  i: number,
  layerCount: number,
): { row: number; open: number } {
  const M = maxHalf(W);
  const HW = hwFor(W);
  const phone = W < PHONE;
  const hw =
    i === 0
      ? 0.75
      : i === layerCount - 1
        ? 0.9
        : ((HW[i] ?? 0) + (HW[i + 1] ?? 0)) / 2;
  const row = Math.round(2 * M * hw * (phone ? 0.96 : 0.9));
  const page = Math.max(row, W - 2 * (W > 1000 ? 170 : 16));
  const open = Math.round(
    Math.min(page, Math.max(row * 1.4, 2 * 360 + 8 + 12)),
  );
  return { row, open };
}

/**
 * The depth readout: the lines of code in the layers passed below the apps.
 * `cur` is the layer under the reading line, `t` how far through it; at the
 * very bottom the whole count shows.
 */
export function depthReadout(
  locs: readonly number[],
  {
    above,
    cur,
    t,
    atBottom,
  }: { above: boolean; cur: number; t: number; atBottom: boolean },
): { value: string; label: string } {
  const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
  if (above)
    return { value: "Sea level", label: `${fmt(locs[0] ?? 0)} lines of apps` };
  let n = 0;
  for (let k = 1; k < cur; k++) n += locs[k] ?? 0;
  n += (locs[cur] ?? 0) * t;
  if (atBottom) n = locs.slice(1).reduce((a, b) => a + b, 0);
  return { value: fmt(n), label: "lines below the surface" };
}

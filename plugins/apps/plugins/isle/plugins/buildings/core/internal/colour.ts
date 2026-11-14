// Colour helpers of the painting kit: parse `#rrggbb` / `rgb(…)` and derive
// `rgba(…)` strings (darker, lighter, mixed, jittered, the sober app accent).

/** A random stream in [0, 1): `PaintState.rnd`, or a seeded `mulberry32`. */
export type Rnd = () => number;

export type Rgb = readonly [number, number, number];

/** The element of `arr` at `i`; throws when out of range (never `undefined`). */
export function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined)
    throw new Error(
      `buildings: index ${i} out of range (length ${arr.length})`,
    );
  return v;
}

/** `#rrggbb` or `rgb(r, g, b)` / `rgba(…)` as its three channels. */
export function rgb(col: string): Rgb {
  if (col.startsWith("#")) {
    const n = parseInt(col.slice(1), 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }
  const m = col.match(/[\d.]+/g);
  if (!m || m.length < 3)
    throw new Error(`buildings: unparseable colour "${col}"`);
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}

const cl = (v: number) => Math.max(0, Math.min(255, v | 0));

export const css = (r: number, g: number, b: number, a = 1): string =>
  `rgba(${cl(r)},${cl(g)},${cl(b)},${a})`;

/** `c1` toward `c2` by `t`. */
export function mix(c1: string, c2: string, t: number, a = 1): string {
  const p = rgb(c1);
  const q = rgb(c2);
  return css(
    p[0] + (q[0] - p[0]) * t,
    p[1] + (q[1] - p[1]) * t,
    p[2] + (q[2] - p[2]) * t,
    a,
  );
}

/** `col` nudged randomly (a hand-painted variation). Consumes 4 `rnd` calls. */
export function jit(col: string, rnd: Rnd, amt = 14, a = 1): string {
  const c = rgb(col);
  const d = (rnd() - 0.5) * amt;
  return css(
    c[0] + d + (rnd() - 0.5) * amt * 0.35,
    c[1] + d + (rnd() - 0.5) * amt * 0.35,
    c[2] + d + (rnd() - 0.5) * amt * 0.35,
    a,
  );
}

/** `col` darkened by `k` (0..1). */
export function dark(col: string, k: number, a = 1): string {
  const c = rgb(col);
  return css(c[0] * (1 - k), c[1] * (1 - k), c[2] * (1 - k), a);
}

/** `col` lightened by `k` (0..1). */
export function light(col: string, k: number, a = 1): string {
  const c = rgb(col);
  return css(
    c[0] + (255 - c[0]) * k,
    c[1] + (255 - c[1]) * k,
    c[2] + (255 - c[2]) * k,
    a,
  );
}

/** The app hue as a sober accent: desaturated ~35 %, darkened ~15 %. */
export function accent(hue: string, k = 0): string {
  const [r, g, b] = rgb(hue);
  const l = (r + g + b) / 3;
  const d = 0.38;
  const m = 0.84 * (1 - k);
  return css(
    (r + (l - r) * d) * m,
    (g + (l - g) * d) * m,
    (b + (l - b) * d) * m,
  );
}

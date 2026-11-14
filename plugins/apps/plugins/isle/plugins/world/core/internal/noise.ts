// Value noise and fractal sums: the one noise every world function reads, so
// terrain, forests and roads agree on where things are.

/** A hash of an integer lattice point → [0, 1). */
export function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smoothstep on [0, 1]. */
export const smooth01 = (t: number): number => t * t * (3 - 2 * t);

/** Smooth value noise → [0, 1). */
export function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = smooth01(x - xi);
  const v = smooth01(y - yi);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal noise over `o` octaves (the ground's: forests, fields). → about [0, 1]. */
export function fbm(x: number, y: number, o = 4): number {
  let s = 0;
  let a = 0.5;
  let f = 1;
  for (let i = 0; i < o; i++) {
    s += a * vnoise(x * f, y * f);
    f *= 2.03;
    a *= 0.5;
  }
  return s / (1 - Math.pow(0.5, o));
}

/** Fractal noise with offset octaves and gain `g` (the island outlines'). → [0, 1). */
export function fbmShape(x: number, y: number, o: number, g = 0.5): number {
  let s = 0;
  let a = 1;
  let f = 1;
  let n = 0;
  for (let i = 0; i < o; i++) {
    s += a * vnoise(x * f + i * 17.3, y * f - i * 9.1);
    n += a;
    f *= 2.03;
    a *= g;
  }
  return s / n;
}

export const clamp = (v: number, a: number, b: number): number =>
  v < a ? a : v > b ? b : v;
export const lerp = (a: number, b: number, t: number): number =>
  a + (b - a) * t;
/** Smoothstep of x between a and b. */
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

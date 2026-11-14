// Colour helpers for the cel shading.

function rgb(c: string): [number, number, number] {
  if (c.startsWith("#")) {
    const n = parseInt(c.slice(1), 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }
  const m = c.match(/[\d.]+/g);
  if (!m || m.length < 3)
    throw new Error(`characters: cannot read colour "${c}"`);
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}

/** `c` darkened (k < 0) or lightened (k > 0) by a fraction, as an `rgb()` string. */
export function mix(c: string, k: number): string {
  const [r, g, b] = rgb(c);
  const f = (v: number) =>
    Math.max(
      0,
      Math.min(255, Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k)),
    );
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

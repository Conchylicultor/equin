/**
 * `col` (`#rrggbb` or `rgb(r, g, b)` / `rgba(…)`) darkened (k < 0) or
 * lightened (k > 0) by |k|, as `rgb(r,g,b)` — the {@link PaintState} `shade`.
 */
export function shade(col: string, k: number): string {
  let r: number;
  let g: number;
  let b: number;
  if (col.startsWith("#")) {
    const n = parseInt(col.slice(1), 16);
    r = n >> 16;
    g = (n >> 8) & 255;
    b = n & 255;
  } else {
    const m = col.match(/[\d.]+/g);
    if (!m || m.length < 3)
      throw new Error(`shade: unparseable colour "${col}"`);
    [r, g, b] = m.map(Number) as [number, number, number];
  }
  const f = (c: number) =>
    Math.max(
      0,
      Math.min(255, Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k)),
    );
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

/**
 * The few SVG-writing helpers both cover renderers share. Covers are strings
 * (served as `image/svg+xml`, never mounted as React), so every number goes
 * through {@link n} — a fixed precision keeps the output deterministic and
 * small, and two renders of one Score are byte-identical.
 */

/** The cover's canvas: 16/10, the gallery card's cover aspect. */
export const COVER_W = 320;
export const COVER_H = 200;

/** A coordinate at one decimal, without a trailing `.0`. */
export function n(value: number): string {
  const r = Math.round(value * 10) / 10;
  return Object.is(r, -0) ? "0" : String(r);
}

/** Wrap a body in the cover's root element. */
export function svgDocument(body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${COVER_W} ${COVER_H}" ` +
    `width="${COVER_W}" height="${COVER_H}" preserveAspectRatio="xMidYMid slice">` +
    body +
    `</svg>`
  );
}

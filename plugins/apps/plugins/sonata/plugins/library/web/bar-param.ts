/**
 * The `;bar` param of the player route (`/sonata/song/:songId;bar;lens`): the
 * musical bar the song opens at (see `barStartBeat` in score/core for the
 * numbering — a pickup is bar 0, the first full bar is bar 1).
 *
 * A URL is typed by hand, pasted or stale, so the value is parsed strictly:
 * only a plain non-negative decimal integer is a bar. Anything else (`3.5`,
 * `-1`, `x`, `03a`) is not a bar position at all, and the song opens at its
 * start, exactly as with no `;bar` — a deep link to a song must still open
 * the song.
 */
export function parseBarParam(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d{1,6}$/.test(raw)) return undefined;
  return Number(raw);
}

/** The `;bar` value for `bar`, the inverse of {@link parseBarParam}. */
export function formatBarParam(bar: number): string {
  if (!Number.isInteger(bar) || bar < 0) {
    throw new Error(`formatBarParam: not a bar number: ${bar}`);
  }
  return String(bar);
}

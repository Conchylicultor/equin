import { RENDER_LOOP } from "../../core";

/**
 * Whether ONE element's recent values of one attribute (oldest first, at most
 * `RENDER_LOOP.VALUE_RING`) show it cycling: a tiny set of values with one
 * revisited `MIN_VALUE_REPEAT` times. The ring must be a single element's —
 * many elements each written once to the same value (thumbnails finishing
 * their loads) repeat a value without any of them oscillating.
 */
export function isOscillating(ring: readonly string[]): boolean {
  if (ring.length < RENDER_LOOP.MIN_VALUE_REPEAT) return false;
  const counts = new Map<string, number>();
  for (const v of ring) counts.set(v, (counts.get(v) ?? 0) + 1);
  return (
    counts.size <= RENDER_LOOP.MAX_DISTINCT_VALUES &&
    Math.max(...counts.values()) >= RENDER_LOOP.MIN_VALUE_REPEAT
  );
}

// Keyframe tracks: every animatable property of a layer or the camera is
// either a constant or a list of keys `[t, value, easing?]`, sorted by t.
// A key's easing shapes the segment that ENDS at it (from the previous key).
// Before the first key the value holds the first; after the last, the last.
// Values are numbers or fixed-length number tuples (interpolated per element).

import { ease, type Easing } from "./easing";

export type Value = number | readonly number[];
export type Key<V extends Value = number> = readonly [
  t: number,
  value: V,
  easing?: Easing,
];
export type Track<V extends Value = number> = V | readonly Key<V>[];

function isKeys<V extends Value>(tr: Track<V>): tr is readonly Key<V>[] {
  return Array.isArray(tr) && tr.length > 0 && Array.isArray(tr[0]);
}

function lerpValue<V extends Value>(a: V, b: V, u: number): V {
  if (typeof a === "number" && typeof b === "number")
    return (a + (b - a) * u) as V;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length)
      throw new Error(
        `track keys of different lengths: [${a.join(",")}] → [${b.join(",")}]`,
      );
    return a.map(
      (x: number, i: number) => x + ((b[i] as number) - x) * u,
    ) as unknown as V;
  }
  throw new Error("track keys of different value kinds");
}

/** The track's value at time t. */
export function sample<V extends Value>(tr: Track<V>, t: number): V {
  if (!isKeys(tr)) return tr as V;
  const first = tr[0] as Key<V>;
  if (t <= first[0]) return first[1];
  for (let i = 1; i < tr.length; i++) {
    const k = tr[i] as Key<V>;
    if (t < k[0]) {
      const p = tr[i - 1] as Key<V>;
      const span = k[0] - p[0];
      const u = span > 0 ? (t - p[0]) / span : 1;
      return lerpValue(p[1], k[1], ease(k[2], u));
    }
  }
  return (tr[tr.length - 1] as Key<V>)[1];
}

/** Throws on keys out of time order, so a misordered track fails at build, not as a frame glitch. */
export function checkTrack(tr: Track<Value> | undefined, where: string): void {
  if (tr === undefined || !isKeys(tr)) return;
  for (let i = 1; i < tr.length; i++) {
    const a = (tr[i - 1] as Key<Value>)[0];
    const b = (tr[i] as Key<Value>)[0];
    if (!(b >= a))
      throw new Error(
        `${where}: key ${i} at t=${b} comes before key ${i - 1} at t=${a}`,
      );
  }
}

/** Shift every key of a track by dt seconds (a constant is unchanged). */
export function shiftTrack<V extends Value>(
  tr: Track<V>,
  dt: number,
): Track<V> {
  if (!isKeys(tr)) return tr;
  return tr.map(([t, v, e]) => [t + dt, v, e] as Key<V>);
}

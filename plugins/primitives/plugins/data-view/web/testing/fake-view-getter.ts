import type { ViewGetter } from "../internal/view-getter";

/**
 * Brand a test fake's per-view getter as a `ViewGetter`. The fake owns the
 * stability contract the brand stands for: return a STORED value (the same
 * object for the same view until the test changes it), never a fresh one per
 * call — a minting fake would re-run every memo keyed on it each render.
 */
export function fakeViewGetter<T>(get: (id: string) => T): ViewGetter<T> {
  return get as ViewGetter<T>;
}

import type { SlotItemAttrsFn, SlotItemBox } from "./types";
import { SlotRender } from "./slots";

// One sorted copy per contribution list: the registry keeps a slot's list
// array stable while it is unchanged, so this sorts once per change, not per
// render.
const sortedByList = new WeakMap<readonly object[], readonly object[]>();

function byDepth<T extends { depth: number }>(
  list: readonly T[],
): readonly T[] {
  let out = sortedByList.get(list) as readonly T[] | undefined;
  if (!out) {
    out = [...list].sort((a, b) => a.depth - b.depth);
    sortedByList.set(list, out);
  }
  return out;
}

/** The contributed item middlewares, lowest depth first (= outermost). */
export function useSlotItemMiddlewares() {
  return byDepth(SlotRender.ItemMiddleware.useContributions());
}

/** The contributed list middlewares, lowest depth first (= outermost). */
export function useSlotListMiddlewares() {
  return byDepth(SlotRender.ListMiddleware.useContributions());
}

/** The merged attributes for one contribution's box, or `null` when none. */
export function useSlotItemAttrs(
  box: SlotItemBox,
): Record<string, string | undefined> | null {
  // Pure and cheap by contract (SlotItemAttrsFn), so recomputed per render.
  return mergeAttrs(SlotRender.ItemAttrs.useContributions(), box);
}

function mergeAttrs(
  fns: readonly { attrs: SlotItemAttrsFn }[],
  box: SlotItemBox,
): Record<string, string | undefined> | null {
  const merged: Record<string, string | undefined> = {};
  let stamped = false;
  for (const { attrs: fn } of fns) {
    const attrs = fn(box);
    if (!attrs) continue;
    stamped = true;
    Object.assign(merged, attrs);
  }
  return stamped ? merged : null;
}

import type { SlotItemAttrsFn, SlotItemBox } from "./types";
import { SlotRender } from "./slots";

// One sorted copy per contribution list: the registry keeps a slot's list
// array stable while it is unchanged, so this sorts once per change, not per
// render.
const sortedByList = new WeakMap<readonly object[], readonly object[]>();

function byPriority<T extends { priority: number }>(
  list: readonly T[],
): readonly T[] {
  let out = sortedByList.get(list) as readonly T[] | undefined;
  if (!out) {
    out = [...list].sort((a, b) => a.priority - b.priority);
    sortedByList.set(list, out);
  }
  return out;
}

/** The contributed item middlewares, lowest priority first (= outermost). */
export function useSlotItemMiddlewares() {
  return byPriority(SlotRender.ItemMiddleware.useContributions());
}

/** The contributed list middlewares, lowest priority first (= outermost). */
export function useSlotListMiddlewares() {
  return byPriority(SlotRender.ListMiddleware.useContributions());
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

import type { FieldOption } from "./types";

/**
 * `value` plus every option below it in the `parent` hierarchy, `value` first.
 * Cycle-safe (each value is visited once). A `value` naming no option yields
 * just `[value]`, so a flat option list's closure is the value itself.
 */
export function optionDescendants(
  options: readonly FieldOption[],
  value: string,
): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const o of options) {
    if (o.parent === undefined) continue;
    const siblings = childrenOf.get(o.parent);
    if (siblings) siblings.push(o.value);
    else childrenOf.set(o.parent, [o.value]);
  }
  const seen = new Set<string>([value]);
  const queue = [value];
  // `queue` grows while iterated: a for-of visits the appended entries too.
  for (const current of queue) {
    for (const child of childrenOf.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return queue;
}

import type {
  FieldGrouping,
  FieldOption,
  FieldValue,
  GroupBucket,
  GroupBucketAncestor,
  GroupingPlanContext,
} from "@plugins/primitives/plugins/data-view/core";

/**
 * The tag type's grouping: one section per tag, NESTED along the option forest
 * (`FieldOption.parent`) — each bucket carries its ancestors, root first, so
 * data-view emits the sections in tree order with rolled-up counts.
 *
 * - **key** — the value (the tag id); **label** / **swatch** — its option's.
 * - **order** — the option's index in `field.options`, which a forest-shaped
 *   option set lists in tree order (pre-order), so it ranks siblings in that
 *   order; an ancestor's `order` is its own index the same way.
 * - **A value naming no option** returns `null` — it joins the one "None"
 *   section (a tag deleted since the row was read, say).
 * - **Cycle-safe.** A `parent` naming no option ends the chain (that option is
 *   a root), and so does a cycle: an option on a cycle is a root, and anything
 *   under it hangs off it — so every bucket mentioning an option agrees on its
 *   chain, which data-view requires.
 *
 * The forest is indexed ONCE per render in `plan`, and each option's chain is
 * memoized, so bucketing a row is a map lookup.
 */
function planTagBuckets(
  ctx: GroupingPlanContext,
): (value: FieldValue) => GroupBucket | null {
  const options = ctx.field.options ?? [];
  // value → its first declaration and that declaration's index (a duplicated
  // option keeps the position its first declaration gave it).
  const byValue = new Map<string, { option: FieldOption; order: number }>();
  options.forEach((option, order) => {
    if (!byValue.has(option.value))
      byValue.set(option.value, { option, order });
  });

  const parentOf = (value: string): string | null => {
    const parent = byValue.get(value)?.option.parent;
    return parent !== undefined && byValue.has(parent) ? parent : null;
  };
  // An option is on a cycle when following its parents comes back to it.
  const onCycle = (value: string): boolean => {
    const seen = new Set<string>();
    for (let at = parentOf(value); at !== null; at = parentOf(at)) {
      if (at === value) return true;
      if (seen.has(at)) return false; // a cycle above, not through, `value`
      seen.add(at);
    }
    return false;
  };

  // A root: no parent option, or on a cycle (whatever is under it hangs off it).
  const isRoot = (value: string): boolean =>
    parentOf(value) === null || onCycle(value);

  const chains = new Map<string, readonly GroupBucketAncestor[]>();
  const ancestorsOf = (value: string): readonly GroupBucketAncestor[] => {
    // Climb to the first option that is a root or whose chain is known, then
    // unwind, memoizing every chain on the way — never recursion over a
    // user-sized tree.
    const climb: string[] = [];
    for (let at: string | null = value; at !== null && !chains.has(at);) {
      climb.push(at);
      at = isRoot(at) ? null : parentOf(at);
    }
    for (let i = climb.length - 1; i >= 0; i--) {
      const node = climb[i]!;
      const up = isRoot(node) ? null : parentOf(node);
      chains.set(node, up === null ? [] : [...chains.get(up)!, ancestor(up)]);
    }
    return chains.get(value)!;
  };
  const ancestor = (value: string): GroupBucketAncestor => {
    const { option, order } = byValue.get(value)!;
    return {
      key: value,
      label: option.label,
      order,
      ...(option.swatch === undefined ? {} : { swatch: option.swatch }),
    };
  };

  return (value) => {
    const key = String(value);
    if (!byValue.has(key)) return null;
    const ancestors = ancestorsOf(key);
    return {
      ...ancestor(key),
      ...(ancestors.length === 0 ? {} : { ancestors }),
    };
  };
}

export const tagGroupings: FieldGrouping[] = [
  {
    id: "tree",
    label: "Nested",
    oneBucketPerValue: true,
    plan: planTagBuckets,
  },
];

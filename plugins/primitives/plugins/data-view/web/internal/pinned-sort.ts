import type { SortRule } from "../../core";

/**
 * Pinned sort rules — the one place that knows the invariant "pinned rules are a
 * prefix of `SortRule[]`". Every code path that APPLIES a sort keeps iterating
 * the one list unchanged (the prefix sorts first by position); only the paths
 * that EDIT rules split it, and they go through here. Pure + immutable.
 */

/** Partition `rules` into the pinned prefix and the user rules, order kept. */
export function splitPinned(rules: readonly SortRule[]): {
  pinned: SortRule[];
  user: SortRule[];
} {
  const pinned: SortRule[] = [];
  const user: SortRule[] = [];
  for (const rule of rules) (rule.pinned ? pinned : user).push(rule);
  return { pinned, user };
}

/**
 * Stable partition, pinned first — applied at both config boundaries (read and
 * write) so a hand-edited row can never put a pinned rule behind a user rule.
 * Returns the input itself when it already satisfies the invariant.
 */
export function normalizeSortRules(rules: SortRule[]): SortRule[] {
  const { pinned, user } = splitPinned(rules);
  const next = [...pinned, ...user];
  return next.every((r, i) => r === rules[i]) ? rules : next;
}

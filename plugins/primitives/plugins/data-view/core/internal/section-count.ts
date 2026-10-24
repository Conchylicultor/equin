import type { SectionCount } from "./types";

/** A section holding exactly `n` rows. */
export function exactCount(n: number): SectionCount {
  return { kind: "exact", n };
}

/** A section holding at least the `n` rows loaded so far. */
export function atLeastCount(n: number): SectionCount {
  return { kind: "atLeast", n };
}

/**
 * The one spelling of a section count: `n`, or `n+` for a lower bound — so no
 * view can print the rows loaded so far as a total.
 */
export function formatSectionCount(count: SectionCount): string {
  return count.kind === "exact" ? String(count.n) : `${count.n}+`;
}

/**
 * Several sections' counts as one — a nested section's own rows plus every
 * descendant's. Exact only when every part is: one lower bound makes the sum a
 * lower bound. No parts is an exact zero.
 */
export function sumSectionCounts(
  counts: readonly SectionCount[],
): SectionCount {
  let n = 0;
  let exact = true;
  for (const count of counts) {
    n += count.n;
    if (count.kind !== "exact") exact = false;
  }
  return exact ? exactCount(n) : atLeastCount(n);
}

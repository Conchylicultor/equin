import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";
import { releaseVersion } from "@plugins/upstream/plugins/release/core";

/** "2026.10.30 → 2026.11.14", or the new release alone when none is held. */
export function updateSpan(current: string | null, latest: string): string {
  return current === null
    ? `${releaseVersion(latest)} available`
    : `${releaseVersion(current)} → ${releaseVersion(latest)}`;
}

/** "312 commits" / "1 commit". */
export function commitCount(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "commit" : "commits"}`;
}

/**
 * An update to make, as the out-of-date row and the reminder say it:
 * "2026.10.30 → 2026.11.14 · 312 commits" — the span, and how many commits it
 * brings.
 */
export function outOfDateSummary(
  current: string | null,
  latest: string,
  commits: number,
): string {
  return `${updateSpan(current, latest)} · ${commitCount(commits)}`;
}

/** The headline of an update to make — the health row's and the reminder's. */
export const OUT_OF_DATE_TITLE = `${PRODUCT_NAME} is out of date`;

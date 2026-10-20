import type { HealthLevel, HealthMerge, HealthStatus, RowLevel } from "./types";

/**
 * Severity rank, worst first. `unknown` outranks `ok` so the merged dot can
 * never claim green before every row has vouched for itself. `not-applicable`
 * ranks only rows (last); the merge never folds it.
 */
const RANK: Record<RowLevel, number> = {
  critical: 0,
  attention: 1,
  unknown: 2,
  ok: 3,
  "not-applicable": 4,
};

/** `undefined` = a registered status row whose probe has not reported yet. */
export type ReportedStatus = HealthStatus | undefined;

/** The level one reported status stands for: an unreported row is `unknown`. */
export function levelOf(status: ReportedStatus): RowLevel {
  return status === undefined ? "unknown" : status.state;
}

/**
 * True when the status is "not known yet": unreported, or `unknown` without a
 * summary. An `unknown` WITH a summary is known to be unreadable — a different
 * claim, rendered still rather than pulsing.
 */
export function isPending(status: ReportedStatus): boolean {
  return (
    status === undefined ||
    (status.state === "unknown" && status.summary === undefined)
  );
}

/** True when the status is a known state on its way to another (`transitioning`). */
export function isTransitioning(status: ReportedStatus): boolean {
  return (
    status !== undefined &&
    status.state !== "unknown" &&
    status.state !== "not-applicable" &&
    status.transitioning === true
  );
}

/** True when the status pulses: not known yet, or on its way to another state. */
export function isPulsing(status: ReportedStatus): boolean {
  return isPending(status) || isTransitioning(status);
}

/**
 * Fold every status row's status into what the dot shows.
 *
 * Precedence `critical > attention > unknown > ok`. Zero rows is `ok`: with
 * nothing registered there is nothing that could be wrong, and nothing pending.
 * A `not-applicable` row is left out, as if it were not registered.
 */
export function mergeHealth(
  statuses: ReadonlyArray<ReportedStatus>,
): HealthMerge {
  let state: HealthLevel = "ok";
  let count = 0;
  let transitioning = false;
  let pending = false;
  for (const status of statuses) {
    const level = levelOf(status);
    if (level === "not-applicable") continue;
    if (RANK[level] < RANK[state]) state = level;
    if (level === "attention" || level === "critical") count++;
    if (isPending(status)) pending = true;
    if (isTransitioning(status)) transitioning = true;
  }
  return { state, count, transitioning, pending };
}

/**
 * The report's one-line verdict — the header of the report, and the button's
 * tooltip and accessible name.
 *
 * - `ok` → "All systems normal"
 * - some row needs attention: exactly one → that row's own summary; more →
 *   "N things need attention"
 * - `unknown` while some row is not known yet → "Checking…"
 * - `unknown` where every unknown row said why → its reason, or
 *   "N checks can't be read right now"
 *
 * `not-applicable` rows are left out, as in the merge.
 */
export function verdictOf(statuses: ReadonlyArray<ReportedStatus>): string {
  const merged = mergeHealth(statuses);
  switch (merged.state) {
    case "ok":
      return "All systems normal";
    case "unknown": {
      if (merged.pending) return "Checking…";
      const unreadable = statuses.filter((s) => levelOf(s) === "unknown");
      const only = unreadable.length === 1 ? unreadable[0] : undefined;
      if (only?.summary !== undefined) return only.summary;
      return `${unreadable.length} checks can't be read right now`;
    }
    case "attention":
    case "critical": {
      if (merged.count > 1) return `${merged.count} things need attention`;
      const only = statuses.find((s) => {
        const level = levelOf(s);
        return level === "attention" || level === "critical";
      });
      // `count === 1` guarantees a match; the fallback only satisfies the type.
      return only?.summary ?? "1 thing needs attention";
    }
  }
}

/** The fields `sortRows` orders by — a contribution or its sealed read. */
export interface SortableRow {
  kind: "status" | "info";
  order: number;
}

/**
 * The report's row order: info rows first (by `order`), then status rows worst
 * first — `not-applicable` ones last — ties broken by `order`, then by
 * registration order (the sort is stable). Returns a new array.
 */
export function sortRows<R extends SortableRow>(
  rows: ReadonlyArray<R>,
  statusOf: (row: R) => ReportedStatus,
): R[] {
  const rank = (row: R): number =>
    row.kind === "info" ? -1 : RANK[levelOf(statusOf(row))];
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.order - b.order);
}

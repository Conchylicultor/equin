import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import type { AllBound } from "./contracts";

/**
 * A whole set declared `unbounded: { reason, budget }` loaded more rows than
 * its budget: the reason it is held whole is no longer true (or the budget
 * was set too low). One body per over-budget load.
 */
export interface LiveSetOverBudget {
  /** The set's key. */
  key: string;
  /** The tuple's params (`{}` for an unscoped set, the scope for `by`). */
  params: Readonly<Record<string, string>>;
  /** How many rows the load read. */
  rows: number;
  /** The declared budget. */
  budget: number;
  /** The declared reason the set stays small. */
  reason: string;
}

/**
 * Where an over-budget whole set is reported: a primitive cannot import
 * `reports`, so `reports/live-set-budget` drains it into a
 * `live-set-over-budget` report.
 */
export const liveSetOverBudgetSink = defineReportSink<LiveSetOverBudget>();

/**
 * Check one load of a whole set against its declared bound's budget: an
 * `unbounded` set that read more rows than `budget` is reported (the rows are
 * still served — a budget is a claim made checkable, never a cap; a capped
 * set's `max` is checked by its own loads). A no-op for a capped set.
 */
export function checkSetBudget(
  key: string,
  bound: AllBound,
  params: Readonly<Record<string, string>>,
  rows: number,
): void {
  const unbounded = bound.unbounded;
  if (unbounded === undefined || rows <= unbounded.budget) return;
  liveSetOverBudgetSink.emit({
    key,
    params,
    rows,
    budget: unbounded.budget,
    reason: unbounded.reason,
  });
}

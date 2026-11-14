/**
 * What kind of problem a report kind records — the axis a consumer splits
 * reports on without naming a kind (supervisor event streams route errors and
 * slow ops to different supervisors).
 *
 * - `error`: something went wrong — a crash, a failed request, a broken
 *   invariant.
 * - `slow-op`: something was too slow or too big — a stall, a slow
 *   interaction, a blown budget.
 */
export const REPORT_CATEGORIES = ["error", "slow-op"] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

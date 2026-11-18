// The updaters' side of the hold model (`deps/hold`): what a held row reports,
// and the review every updater's holds pass before an upgrade or detection.

import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  HOLD_MAX_DAYS,
  holdProblems,
  holdState,
  lapsedHolds,
  utcDay,
  type Hold,
} from "@plugins/infra/plugins/deps/plugins/hold/core";
import type { OutdatedWaiting, Updater } from "./updater";

/** What a held row reports: the hold's reason, its review day, and whether that has passed. */
export function heldWaiting(
  hold: Hold,
  today: string,
): Extract<OutdatedWaiting, { kind: "held" }> {
  return {
    kind: "held",
    reason: hold.reason,
    reviewBy: hold.reviewBy,
    lapsed: holdState(hold, today) === "lapsed",
  };
}

/**
 * `updater`'s lapsed holds on `now`'s day, after refusing (throwing, naming
 * every offender) any hold set past its bound. The runner and the detect job
 * call it before asking the updater anything, so every updater's holds are
 * bounded and reviewed whether or not a check of its own reads them.
 */
export async function reviewableHolds(
  updater: Updater,
  root: AppPath,
  now: Date,
): Promise<Hold[]> {
  const holds = await updater.holds.read(root);
  const today = utcDay(now);
  const problems = holdProblems(holds, today, updater.holds.file);
  if (problems.length > 0)
    throw new Error(
      `${updater.id}: a hold is set past its ${HOLD_MAX_DAYS}-day bound:\n  ${problems.join("\n  ")}`,
    );
  return lapsedHolds(holds, today);
}

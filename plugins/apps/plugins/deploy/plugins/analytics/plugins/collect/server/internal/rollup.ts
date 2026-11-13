import { lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { CONSENT_KEY_DAYS, addDays, utcDay } from "../../core";
import { daysMissingTotals, rollupDay } from "./aggregate-sql";
import { firstIdentityDay, type AnalyticsDb } from "./collect";
import {
  analyticsConsentKeys,
  analyticsSalts,
  analyticsVisitorLinks,
} from "./tables";

/**
 * How many completed days every run recomputes, whether or not they already
 * have totals. A visit is attributed to the day it STARTED, and one that began
 * just before midnight can keep collecting hits after the 00:15 run — so the
 * next night sums that day again with those late hits in.
 */
export const ROLLUP_RECOMPUTE_DAYS = 2;

/**
 * One rollup run as of `now`: recompute the last {@link ROLLUP_RECOMPUTE_DAYS}
 * completed days, backfill any older completed day that has visits but no
 * totals or memberships, then delete every salt and hash → visitor link older
 * than the identity window, so a visitor absent that long can never be linked
 * again, and every consent key unused for `CONSENT_KEY_DAYS` (its browser has
 * forgotten it). Returns the days it summed.
 */
export async function runRollup(
  dbx: AnalyticsDb,
  now: Date,
): Promise<{ days: string[] }> {
  const today = utcDay(now);
  const recent = Array.from({ length: ROLLUP_RECOMPUTE_DAYS }, (_, i) =>
    addDays(today, -(i + 1)),
  );
  const days = [
    ...new Set([...(await daysMissingTotals(dbx, today)), ...recent]),
  ].sort();
  for (const day of days) {
    await rollupDay(dbx, day);
  }
  const oldest = firstIdentityDay(today);
  await dbx.delete(analyticsSalts).where(lt(analyticsSalts.day, oldest));
  await dbx
    .delete(analyticsVisitorLinks)
    .where(lt(analyticsVisitorLinks.day, oldest));
  await dbx
    .delete(analyticsConsentKeys)
    .where(lt(analyticsConsentKeys.lastDay, addDays(today, -CONSENT_KEY_DAYS)));
  return { days };
}

/**
 * Nightly at 00:15 UTC, just after the salt's day ends.
 *
 * `perWorktree: true` is REQUIRED, not a dev convenience: a non-perWorktree
 * cron only installs when the backend is main (`isMain()`), and a deployed
 * release never is — without it the deployed site would never roll up, never
 * delete a salt, and the retention guard would (correctly) refuse to sweep.
 * Each worktree and each install has its own analytics tables, so there is
 * nothing shared to race over.
 */
export const analyticsRollupJob = defineJob({
  name: "analytics.rollup",
  description:
    "Summarizes each finished day's visits into totals and purges expired visitor-linking data.",
  // SQL only: a grouped INSERT … SELECT per day over indexed rows.
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "15 0 * * *", perWorktree: true },
  async run() {
    await runRollup(db, new Date());
  },
});

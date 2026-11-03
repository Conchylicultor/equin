import { clockParam } from "@plugins/network/plugins/live/core";
import {
  wallClockToInstant,
  zoneWallClock,
} from "@plugins/packages/plugins/wall-clock/core";

/** Google's monthly free allowances reset on Pacific time. */
const BILLING_ZONE = "America/Los_Angeles";

export interface BillingMonth {
  /** `YYYY-MM`, the ledger's month key. */
  key: string;
  /** The instant the next month (and its allowance) begins. */
  resetsAt: Date;
}

/**
 * The billing month, as a clock param: a reader of this month's counts (the
 * browser, a typed-query value's question) fills it from its clock
 * (`useClockParam`) and re-pins it at the turn of the month in Pacific time —
 * so a served value never reads the clock itself.
 */
export const MAPS_BILLING_MONTH = clockParam.month({ zone: BILLING_ZONE });

/** The billing month a `YYYY-MM` key names (a pinned `MAPS_BILLING_MONTH`). */
export function billingMonthOf(key: string): BillingMonth {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (m === null) throw new Error(`billingMonthOf: "${key}" is not YYYY-MM`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const next =
    month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return {
    key,
    resetsAt: wallClockToInstant({ ...next, day: 1 }, BILLING_ZONE),
  };
}

/** The billing month `now` falls in. */
export function billingMonth(now: Date): BillingMonth {
  const { year, month } = zoneWallClock(now, BILLING_ZONE);
  const next =
    month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return {
    key: `${year}-${String(month).padStart(2, "0")}`,
    resetsAt: wallClockToInstant({ ...next, day: 1 }, BILLING_ZONE),
  };
}

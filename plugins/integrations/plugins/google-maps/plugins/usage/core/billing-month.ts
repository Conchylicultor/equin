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

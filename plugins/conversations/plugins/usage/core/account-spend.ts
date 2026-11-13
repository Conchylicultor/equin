import { z } from "zod";
import { clockParam, liveValue } from "@plugins/network/plugins/live/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

/**
 * The month an account's spend is read for, as a clock param: UTC, like the
 * days the spend is filed under. The reader fills it (`useClockParam`) and
 * re-pins it at the turn of the UTC month — a served read never reads the
 * clock itself.
 */
export const ACCOUNT_SPEND_MONTH = clockParam.month({ zone: "UTC" });

const AccountSpendDaySchema = z.object({
  /** UTC day, `YYYY-MM-DD`. */
  date: z.string(),
  costUsd: z.number(),
});
export type AccountSpendDay = z.infer<typeof AccountSpendDaySchema>;

/**
 * What one Claude account spent per UTC day of one month, at API prices —
 * counted from the agents equin ran on it (the usage sync files each newly
 * priced cost under the account running the agent at the time). Spend outside
 * equin, and before the account was first counted, is not in it. "Today" is
 * picked in the browser, where the day moves with the clock.
 *
 * BOUND: one entry per day of the month the account spent anything — 31 at
 * most.
 */
export const claudeAccountSpend = liveValue(
  "conversations.usage.account-spend",
  {
    schema: z.object({
      days: cappedList(AccountSpendDaySchema, { max: 31 }),
    }),
    params: { accountId: z.string().min(1), month: ACCOUNT_SPEND_MONTH },
  },
);

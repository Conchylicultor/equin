import { describe, expect, test } from "bun:test";
import { cronRanges } from "@plugins/infra/plugins/jobs/machine";
import { cronWords } from "./cron-words";

// Through graphile's own parse, as the provider does — so a pattern the
// scheduler reads differently from how it looks would show up here.
const words = (expr: string) => cronWords(cronRanges(expr), expr);

describe("cronWords", () => {
  test.each([
    ["* * * * *", "Every minute"],
    ["*/5 * * * *", "Every 5 minutes"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["*/30 * * * *", "Every 30 minutes"],
    ["0 * * * *", "Hourly"],
    ["23 * * * *", "Hourly at :23"],
    ["0 */6 * * *", "Every 6 hours at :00"],
    ["0 3 * * *", "Daily 03:00 UTC"],
    ["15 0 * * *", "Daily 00:15 UTC"],
    ["0 3,15 * * *", "Daily 03:00, 15:00 UTC"],
    ["40 3 * * 1", "Mondays 03:40 UTC"],
    ["0 9 * * 1-5", "Weekdays 09:00 UTC"],
    ["0 9 * * 1,3", "Mon, Wed 09:00 UTC"],
    ["0 4 1 * *", "Monthly on the 1st 04:00 UTC"],
  ])("%s → %s", (expr, expected) => {
    expect(words(expr)).toBe(expected);
  });

  test.each([
    "0 4 * 1 *", // one month only
    "*/7 * * * *", // a step that does not divide the hour
    "0,10 */2 * * *", // several minutes across stepped hours
    "0 4 1 * 1", // dates AND days of week (cron ORs them)
  ])("%s falls back to the expression", (expr) => {
    expect(words(expr)).toBe(expr);
  });
});

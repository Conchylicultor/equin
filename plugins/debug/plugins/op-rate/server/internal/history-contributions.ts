import { ExcludeFromChangeFeed } from "@plugins/network/plugins/live/plugins/change-feed/server";
import {
  ExcludeFromBackup,
  ExcludeFromFork,
} from "@plugins/database/plugins/admin/server";
import { defineRetention } from "@plugins/infra/plugins/retention/server";
import { BASELINE_DAYS } from "./op-rate-baseline";
import {
  _opRateHourCalls,
  _opRateWindowCounts,
  _opRateWindows,
} from "./tables";

// The call history op-rate judges against is a measurement of THIS backend's
// traffic in THIS database:
//  - no change feed: written every 5 min by the monitor, read only by it;
//  - no fork: a worktree judged against main's traffic would be judged against
//    a load it never carries (it warms up on its own history instead);
//  - no backup: a week of observability, not user data.
// The baseline reads BASELINE_DAYS whole days before today; one more day is
// kept so the oldest of them is never swept while it is read.

const feedReason =
  "Written every monitor tick by op-rate itself and read only by it; nothing live reads it.";
const forkReason =
  "Call counts measured on the backend that wrote them; a fork judged against main's traffic would be judged against a load it never carries.";
const backupReason =
  "A week of call-rate observability, swept daily; not user data.";

export const historyContributions = [
  ExcludeFromChangeFeed({ table: _opRateWindowCounts, reason: feedReason }),
  ExcludeFromChangeFeed({ table: _opRateWindows, reason: feedReason }),
  ExcludeFromChangeFeed({ table: _opRateHourCalls, reason: feedReason }),
  ExcludeFromFork({ table: _opRateWindowCounts, reason: forkReason }),
  ExcludeFromFork({ table: _opRateWindows, reason: forkReason }),
  ExcludeFromFork({ table: _opRateHourCalls, reason: forkReason }),
  ExcludeFromBackup({ table: _opRateWindowCounts, reason: backupReason }),
  ExcludeFromBackup({ table: _opRateWindows, reason: backupReason }),
  ExcludeFromBackup({ table: _opRateHourCalls, reason: backupReason }),
];

export const windowCountsRetention = defineRetention({
  table: _opRateWindowCounts,
  column: "dayStart",
  ttlDays: BASELINE_DAYS + 2,
  perWorktree: true,
});
export const windowsRetention = defineRetention({
  table: _opRateWindows,
  column: "hourStart",
  ttlDays: BASELINE_DAYS + 2,
  perWorktree: true,
});
export const hourCallsRetention = defineRetention({
  table: _opRateHourCalls,
  column: "hourStart",
  ttlDays: BASELINE_DAYS + 2,
  perWorktree: true,
});

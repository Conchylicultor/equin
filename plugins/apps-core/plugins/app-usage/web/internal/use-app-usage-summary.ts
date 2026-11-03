import { useClockParam, useLive } from "@plugins/network/plugins/live/web";
import { APP_USAGE_TODAY, appUsageSummary } from "../../core";

/**
 * The live per-app usage summary (7-day and all-time opens and active time,
 * last opened), its 7 days ending today — re-read at local midnight. A
 * `ResourceResult`: while it loads there is no stand-in — an app absent from
 * a READY summary has simply never been used.
 */
export function useAppUsageSummary() {
  return useLive(appUsageSummary, { today: useClockParam(APP_USAGE_TODAY) });
}

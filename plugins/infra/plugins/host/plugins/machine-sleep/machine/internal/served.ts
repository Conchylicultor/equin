import { serveValue } from "@plugins/network/plugins/live/machine";
import { machineSleep } from "../../core";
import { currentSleepReading, onSleepReadingChanged } from "../../server";

// External, not DB-backed: the truth is the OS clock, which no change feed
// observes, so the server half's publisher tells this value when a reading
// moved — for as long as some tab reads it (a fresh subscription loads the
// current reading, so nothing is missed in between). Pushed (the liveValue
// default): one small value, the same for every tab.
export const machineSleepServed = serveValue(machineSleep, {
  source: "external",
  changes: "notified",
  loader: () => currentSleepReading(),
  whileSubscribed: (_params, notify) => onSleepReadingChanged(() => notify()),
});

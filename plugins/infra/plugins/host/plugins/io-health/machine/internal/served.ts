import { serveValue } from "@plugins/network/plugins/live/machine";
import { hostIoHealth } from "../../core";
import { ioHealthState, refreshIoHealth } from "./service";

// External: the truth is the monitor's log, which no change feed observes.
// The state notifies after each refresh that changed the value (one per tick
// the monitor appends at most). Pushed: one small value, the same for every
// tab, read by the always-mounted health dot.
export const hostIoHealthServed = serveValue(hostIoHealth, {
  source: "external",
  changes: "notified",
  loader: async () => {
    const v = ioHealthState.current();
    if (v !== null) return v;
    // Subscribed before onReady's first read finished: read now.
    await refreshIoHealth();
    const after = ioHealthState.current();
    if (after === null)
      throw new Error("io-health: the first refresh produced no value");
    return after;
  },
  whileSubscribed: (_params, notify) => ioHealthState.subscribe(() => notify()),
});

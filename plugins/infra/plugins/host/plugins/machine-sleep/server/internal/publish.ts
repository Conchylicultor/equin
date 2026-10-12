import { readSleepClock } from "@plugins/packages/plugins/sleep-clock/core";
import { serveValue } from "@plugins/network/plugins/live/server";
import { machineSleep } from "../../core";
import { createSleepPublisher } from "./sleep-publisher";

const publisher = createSleepPublisher(readSleepClock, () =>
  machineSleepServed.notify(),
);

// External, not DB-backed: the truth is the OS clock, which no change feed
// observes, so publishSleepReading() calls notify() when it moved. Pushed (the
// liveValue default): one small value, the same for every tab.
export const machineSleepServed = serveValue(machineSleep, {
  source: "external",
  changes: "notified",
  loader: () => publisher.current(),
});

/**
 * Read the machine's sleep clock and push it if it changed — in practice only
 * after a wake. Cheap (two clock reads and one sysctl), so a periodic observer
 * that already runs can call it on every tick; it adds no poller of its own.
 */
export function publishSleepReading(): void {
  publisher.publish();
}

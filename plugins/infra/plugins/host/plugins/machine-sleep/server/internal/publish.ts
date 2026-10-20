import { readSleepClock } from "@plugins/packages/plugins/sleep-clock/core";
import type { SleepNow } from "../../core";
import { createSleepPublisher } from "./sleep-publisher";

// The one publisher of this process: the server half owns the reading (other
// plugins' server code drives it through publishSleepReading), and the machine
// half serves it as the machine.sleep live value, subscribed for as long as a
// tab reads it.
const publisher = createSleepPublisher(readSleepClock);

/**
 * Read the machine's sleep clock and push it if it changed — in practice only
 * after a wake. Cheap (two clock reads and one sysctl), so a periodic observer
 * that already runs can call it on every tick; it adds no poller of its own.
 */
export function publishSleepReading(): void {
  publisher.publish();
}

/** The last published reading, reading the clock first if nothing was yet. */
export function currentSleepReading(): SleepNow {
  return publisher.current();
}

/** Run `fn` whenever {@link publishSleepReading} finds a changed reading. Returns the unsubscribe. */
export function onSleepReadingChanged(fn: () => void): () => void {
  return publisher.subscribe(fn);
}

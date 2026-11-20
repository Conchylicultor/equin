import { readSleepClock } from "@plugins/packages/plugins/sleep-clock/core";
import type { SleepNow } from "../../core";
import { createSleepPublisher, type WakeBefore } from "./sleep-publisher";

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

/**
 * ms the machine slept inside `[startMs, endMs]` (epoch ms) — for taking a nap
 * off a span timed on the wall clock (a slow-op measured in a browser). Reads
 * the clock first, so a wake moments ago counts. A process knows only the
 * sleeps it lived through; `null` where the platform cannot tell.
 */
export function sleptDuring(startMs: number, endMs: number): number | null {
  return publisher.sleptDuring(startMs, endMs);
}

/**
 * The wall-clock instant (epoch ms) `awakeMs` of AWAKE time before `endMs` —
 * for a bound on work this machine does that a wall-clock age would let a nap
 * spend (the job sweeper's lock-acquisition grace). Reads the clock first, so a
 * wake moments ago counts. A process knows only the sleeps it lived through;
 * `null` where the platform cannot tell.
 */
export function awakeSpanStart(endMs: number, awakeMs: number): number | null {
  return publisher.awakeSpanStart(endMs, awakeMs);
}

/**
 * Whether the machine had just woken at `atMs` (epoch ms): the sleep this
 * process saw end in the `withinMs` before it — for saying so on what a wake
 * explains (a timer that counted the nap firing the moment the box woke). Reads
 * the clock first, so a wake moments ago counts. A process knows only the
 * sleeps it lived through: `sleep: null` is "none seen", and
 * `{ supported: false }` where the platform cannot tell.
 */
export function wakeBefore(atMs: number, withinMs: number): WakeBefore {
  return publisher.wakeBefore(atMs, withinMs);
}

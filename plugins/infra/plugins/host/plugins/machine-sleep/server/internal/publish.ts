import { readSleepClock } from "@plugins/packages/plugins/sleep-clock/core";
import type { SleepNow } from "../../core";
import { armAwakeTimeout, createSleepPublisher } from "./sleep-publisher";

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
 * `setTimeout` on AWAKE time: `fn` runs once the machine has been awake for
 * `awakeMs` since the call, however long it slept meanwhile — for a bound on
 * work this machine does (a job's hold deadline) that a nap must not spend.
 * A wall-clock timer where the platform cannot tell. Returns the cancel.
 */
export function setAwakeTimeout(fn: () => void, awakeMs: number): () => void {
  return armAwakeTimeout(publisher, fn, awakeMs, {
    now: () => Date.now(),
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
}

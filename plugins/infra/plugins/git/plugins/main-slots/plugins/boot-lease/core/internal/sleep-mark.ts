import { readSleepClock } from "@plugins/packages/plugins/sleep-clock/core";
import type { SleepMark } from "./layout";

/**
 * The machine's sleep clock right now, as a stamp stores it — `null` where the
 * platform cannot tell (off darwin), which every judge reads as the wall clock.
 * Synchronous and light (a lazily dlopen'd libSystem, like packages/flock), so
 * the exit-handler release path can read it.
 */
export function sleepMarkNow(): SleepMark | null {
  const r = readSleepClock();
  return r.supported ? { boot: r.boot, asleepMs: r.asleepMs } : null;
}

import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  awakeSpanStart,
  currentSleepReading,
  onSleepReadingChanged,
  publishSleepReading,
  setAwakeTimeout,
  sleptDuring,
  wakeBefore,
} from "./internal/publish";
export type { SleepInterval, WakeBefore } from "./internal/sleep-publisher";

export default {
  description:
    "The machine's sleep clock, read and published: publishSleepReading() re-reads it and tells its listeners only when it changed — called by an existing periodic observer, so a wake reaches the browser without a poller of its own — with currentSleepReading() and onSleepReadingChanged() for the machine half that serves it as the machine.sleep live value, sleptDuring(start, end) — the sleep this process saw inside a wall-clock span — awakeSpanStart(end, awakeMs) — the wall-clock instant that much awake time before end, stepping over those sleeps — setAwakeTimeout(fn, awakeMs), a timer that a sleep does not spend, and wakeBefore(at, within) — the sleep whose wake came just before an instant, so what a wake explains can say the machine had just woken.",
} satisfies ServerPluginDefinition;

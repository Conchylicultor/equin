import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  awakeSpanStart,
  currentSleepReading,
  onSleepReadingChanged,
  publishSleepReading,
  setAwakeTimeout,
  sleptDuring,
} from "./internal/publish";

export default {
  description:
    "The machine's sleep clock, read and published: publishSleepReading() re-reads it and tells its listeners only when it changed — called by an existing periodic observer, so a wake reaches the browser without a poller of its own — with currentSleepReading() and onSleepReadingChanged() for the machine half that serves it as the machine.sleep live value, sleptDuring(start, end) — the sleep this process saw inside a wall-clock span — and awakeSpanStart(end, awakeMs) — the wall-clock instant that much awake time before end, stepping over those sleeps — and setAwakeTimeout(fn, awakeMs), a timer that a sleep does not spend.",
} satisfies ServerPluginDefinition;

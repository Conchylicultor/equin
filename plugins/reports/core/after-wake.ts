import { formatDuration } from "@plugins/fields/plugins/duration/core";
import type { ReportOccurrence } from "./entity";

/**
 * An occurrence that came just after a wake, in words: "400ms after the
 * machine woke from 4m 28s asleep" — or null for one that did not (or could
 * not tell). The one spelling the occurrences table and the investigation
 * task share.
 */
export function formatAfterWake(
  o: Pick<ReportOccurrence, "at" | "afterWake">,
): string | null {
  if (o.afterWake === null) return null;
  const after = Math.max(0, o.at - o.afterWake.wokeAt);
  return `${formatDuration(after)} after the machine woke from ${formatDuration(o.afterWake.sleptMs)} asleep`;
}

/**
 * The investigation task's line about the machine's wakes, or null when no
 * kept occurrence came just after one: how many did, and the latest of them —
 * so an investigator reads "the box had just woken" before treating it as a
 * crash.
 */
export function afterWakeSummary(
  recent: readonly Pick<ReportOccurrence, "at" | "afterWake">[],
): string | null {
  const woke = recent.flatMap((o) =>
    o.afterWake === null ? [] : [{ at: o.at, afterWake: o.afterWake }],
  );
  if (woke.length === 0) return null;
  const latest = woke.reduce((a, b) => (b.at > a.at ? b : a));
  const share =
    woke.length === recent.length
      ? recent.length === 1
        ? "Its occurrence"
        : `All ${recent.length} kept occurrences`
      : `${woke.length} of the ${recent.length} kept occurrences`;
  return (
    `${share} came just after the machine woke from sleep (latest: ${formatAfterWake(latest)}, ` +
    `woke ${new Date(latest.afterWake.wokeAt).toISOString()}). ` +
    "A nap explains what fires on wake — timers that counted the sleep (connection logins, query and lock waits) " +
    "time out the moment the machine wakes — so check whether it also happens while the machine is awake before treating it as a crash."
  );
}

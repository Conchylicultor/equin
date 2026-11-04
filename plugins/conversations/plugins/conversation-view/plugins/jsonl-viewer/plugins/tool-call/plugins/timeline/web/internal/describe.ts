export type TimelineInput = {
  lookbackMinutes?: number;
  endIso?: string;
  minSeverity?: "info" | "warning" | "error";
  sources?: string[];
  maxEvents?: number;
};

function span(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

/** What the call asked for, in words: "last 30 min", "14 min before
 *  2026-10-31T14:40:00Z · warnings and errors · slow-op, trace". The defaults
 *  (30 minutes ending now, every severity and source) are said as such. */
export function describeTimelineInput(input: TimelineInput): string {
  const minutes = input.lookbackMinutes ?? 30;
  const parts = [
    input.endIso === undefined
      ? `last ${span(minutes)}`
      : `${span(minutes)} before ${input.endIso}`,
  ];
  if (input.minSeverity === "warning") parts.push("warnings and errors");
  if (input.minSeverity === "error") parts.push("errors only");
  if (input.sources && input.sources.length > 0)
    parts.push(input.sources.join(", "));
  return parts.join(" · ");
}

/** `· 14 events` — what came back; `· 14 of 1,039 events` when the cap or the
 *  severity floor left some out. */
export function eventsNote(shown: number, found: number): string {
  if (found > shown)
    return `· ${shown} of ${found.toLocaleString("en-US")} events`;
  return `· ${shown} event${shown === 1 ? "" : "s"}`;
}

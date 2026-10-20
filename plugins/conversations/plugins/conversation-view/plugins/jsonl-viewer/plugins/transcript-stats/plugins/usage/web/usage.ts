import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";

export interface UsageTotals {
  /** Every output token the agent has produced up to here. */
  output: number;
  /**
   * The prompt size of the LAST message that produced output — the current
   * context window, not a running total, which is why it is a latest-wins read
   * rather than a sum.
   */
  latestContext: number;
}

/** Fold the transcript's per-message usage into the two numbers the strip shows. */
export function aggregateUsage(events: JsonlEvent[]): UsageTotals | null {
  if (events.length === 0) return null;
  let output = 0;
  let latestContext = 0;
  let sawAny = false;
  for (const event of events) {
    if (event.kind !== "assistant-text" && event.kind !== "tool-call") continue;
    if (!event.usage) continue;
    sawAny = true;
    output += event.usage.output;
    latestContext =
      event.usage.input + event.usage.cacheRead + event.usage.cacheCreation;
  }
  return sawAny ? { output, latestContext } : null;
}

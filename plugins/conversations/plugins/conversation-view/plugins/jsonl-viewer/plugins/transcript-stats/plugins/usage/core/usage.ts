import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  TRANSCRIPT_FOLD_PARAMS,
  type TranscriptFold,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/transcript-stats/core";

const UsageStateSchema = z.object({
  /** Every output token the agent has produced up to here. */
  output: z.number(),
  /**
   * The prompt size of the LAST message that produced output — the current
   * context window, not a running total, which is why it is a latest-wins read
   * rather than a sum.
   */
  latestContext: z.number(),
  /** Whether any message reported usage yet. */
  sawAny: z.boolean(),
});
export type UsageState = z.infer<typeof UsageStateSchema>;

/** The two numbers the strip shows, or null before any message reported usage. */
export interface UsageTotals {
  output: number;
  latestContext: number;
}

/** Fold the transcript's per-message usage, message by message. */
export const usageFold: TranscriptFold<UsageState> = {
  init: () => ({ output: 0, latestContext: 0, sawAny: false }),
  step: (state, event: JsonlEvent) => {
    if (event.kind !== "assistant-text" && event.kind !== "tool-call") {
      return state;
    }
    if (!event.usage) return state;
    return {
      output: state.output + event.usage.output,
      latestContext:
        event.usage.input + event.usage.cacheRead + event.usage.cacheCreation,
      sawAny: true,
    };
  },
  before: liveValue("transcript-stats.usage.before", {
    schema: UsageStateSchema,
    params: TRANSCRIPT_FOLD_PARAMS,
  }),
};

export function usageTotals(state: UsageState): UsageTotals | null {
  return state.sawAny
    ? { output: state.output, latestContext: state.latestContext }
    : null;
}

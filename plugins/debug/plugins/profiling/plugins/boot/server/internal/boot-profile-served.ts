import { serveValue } from "@plugins/network/plugins/live/server";
import { bootProfiling } from "../../core";
import { readBootProfile } from "./boot-profile";

export const bootProfilingServed = serveValue(bootProfiling, {
  source: "external",
  changes: {
    snapshot: {
      reason:
        "the profile grows after serving starts (onReady / onAllReady spans, warm-ups, the closing drainWarmups span, the gateway report) and neither the profiler nor the gateway report has a change signal; re-read on mount and on the pane's Refresh",
    },
  },
  loader: readBootProfile,
});

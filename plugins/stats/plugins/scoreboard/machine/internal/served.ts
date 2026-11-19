import { serveValue } from "@plugins/network/plugins/live/machine";
import { responsivenessScoreboard } from "../../core";
import { loadScoreboard } from "./load";

// Measured when a reader asks (opening the card, or its Refresh): every input
// is a day-level trend (the latency ledger's day rollups, the report history,
// main's boot log and git history), so nothing about it needs to move while the
// page is open.
export const scoreboardServed = serveValue(responsivenessScoreboard, {
  source: "external",
  changes: {
    snapshot: {
      reason:
        "a day-level trend over files, git and feed-excluded tables: re-measured when the card opens or is refreshed",
    },
  },

  loader: () => loadScoreboard(),
});

import noSyncFs from "./no-sync-fs";
import noUnprovenClaim from "./no-unproven-claim";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "user-path",
  rules: {
    // A synchronous fs call takes only a path proven app-owned (AppPath).
    "no-sync-fs": noSyncFs,
    // Typing a path AppPath without a proof is a claim its file declares.
    "no-unproven-claim": noUnprovenClaim,
  },
  // A claim is a reviewed fact about one file (sanctioned, with its reason),
  // never debt to burn down later: the unproven path is the hazard itself.
  noDebt: ["no-unproven-claim"],
  // Processes that never host a backend's JS thread: the CLI, scripts, bins
  // and install steps freeze only themselves, in front of whoever ran them.
  outOfScope: {
    "no-sync-fs": ["cli", "script", "bin", "provision"],
    "no-unproven-claim": ["cli", "script", "bin", "provision"],
  },
} satisfies LintContribution;

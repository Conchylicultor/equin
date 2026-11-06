import noSyncFs from "./no-sync-fs";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "blocking-fs",
  rules: {
    // No synchronous fs call on a backend's JS thread.
    "no-sync-fs": noSyncFs,
  },
  // Processes that never host a backend's JS thread: the CLI, scripts, bins
  // and install steps freeze only themselves, in front of whoever ran them.
  outOfScope: {
    "no-sync-fs": ["cli", "script", "bin", "provision"],
  },
} satisfies LintContribution;

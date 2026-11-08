import noSyncFs from "./no-sync-fs";
import syncNamed from "./sync-named";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "blocking-fs",
  rules: {
    // No synchronous fs call, sync child process or *Sync helper on a
    // backend's JS thread.
    "no-sync-fs": noSyncFs,
    // A core/shared/data-dirs helper that blocks is named *Sync.
    "sync-named": syncNamed,
  },
  // Processes that never host a backend's JS thread: the CLI, scripts, bins
  // and install steps freeze only themselves, in front of whoever ran them.
  outOfScope: {
    "no-sync-fs": ["cli", "script", "bin", "provision"],
  },
} satisfies LintContribution;

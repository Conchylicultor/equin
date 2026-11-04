import noUntimedFsRead from "./no-untimed-fs-read";
import noUntimedGlobScan from "./no-untimed-glob-scan";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "timed-fs",
  rules: {
    // File reads, listings and stats come from timed-fs (node's names and types).
    "no-untimed-fs-read": noUntimedFsRead,
    // A Bun.Glob scan goes through scanGlob / scanGlobSync.
    "no-untimed-glob-scan": noUntimedGlobScan,
  },
  // Generated files are written by codegen, never run as a process's reads.
  outOfScope: {
    "no-untimed-fs-read": ["research", "generated"],
    "no-untimed-glob-scan": ["research", "generated"],
  },
} satisfies LintContribution;

import noSyncFs from "./no-sync-fs";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "user-path",
  rules: {
    // A user-chosen path never reaches a synchronous fs call.
    "no-sync-fs": noSyncFs,
  },
} satisfies LintContribution;

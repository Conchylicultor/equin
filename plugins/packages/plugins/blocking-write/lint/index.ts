import noBareStdioWriteSync from "./no-bare-stdio-write-sync";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "blocking-write",
  rules: {
    // A synchronous write to stdout / stderr goes through writeAllSync.
    "no-bare-stdio-write-sync": noBareStdioWriteSync,
  },
  // A test may write raw to show the failure; generated files run nothing.
  outOfScope: {
    "no-bare-stdio-write-sync": ["test", "research", "generated"],
  },
} satisfies LintContribution;

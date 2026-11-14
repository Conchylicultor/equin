import noTextSourceRead from "./no-text-source-read";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "source-read-safety",
  rules: {
    "no-text-source-read": noTextSourceRead,
  },
} satisfies LintContribution;

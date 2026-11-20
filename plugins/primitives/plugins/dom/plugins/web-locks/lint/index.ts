import noRawNavigatorLocks from "./no-raw-navigator-locks";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "web-locks",
  rules: {
    "no-raw-navigator-locks": noRawNavigatorLocks,
  },
} satisfies LintContribution;

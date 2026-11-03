import noPendingDataCollapse from "./no-pending-data-collapse";
import noReadyNegation from "./no-ready-negation";
import noHandrolledResult from "./no-handrolled-result";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "live-state",
  rules: {
    "no-pending-data-collapse": noPendingDataCollapse,
    "no-ready-negation": noReadyNegation,
    "no-handrolled-result": noHandrolledResult,
  },
  closed: ["no-pending-data-collapse"],
} satisfies LintContribution;

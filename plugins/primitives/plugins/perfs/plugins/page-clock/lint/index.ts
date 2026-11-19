import noTimeOriginArithmetic from "./no-time-origin-arithmetic";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "page-clock",
  rules: {
    "no-time-origin-arithmetic": noTimeOriginArithmetic,
  },
} satisfies LintContribution;

import noBlockingCheckWork from "./no-blocking-check-work";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "check-thread-safety",
  rules: {
    "no-blocking-check-work": noBlockingCheckWork,
  },
} satisfies LintContribution;

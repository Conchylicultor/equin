import noApiAboveFloor from "./no-api-above-floor";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "browser-floor",
  rules: {
    // Browser-built code uses only built-ins every floor browser has.
    "no-api-above-floor": noApiAboveFloor,
  },
} satisfies LintContribution;

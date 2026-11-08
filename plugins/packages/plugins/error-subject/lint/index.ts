import crashFieldsOf from "./crash-fields-of";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "error-subject",
  rules: {
    // Crash fields are derived from the error, so its subject reaches the report.
    "crash-fields-of": crashFieldsOf,
  },
  // A test pins a payload's literal shape; research and generated files file nothing.
  outOfScope: {
    "crash-fields-of": ["test", "research", "generated"],
  },
} satisfies LintContribution;

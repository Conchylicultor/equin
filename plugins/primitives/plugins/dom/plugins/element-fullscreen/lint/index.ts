import noRawRequestFullscreen from "./no-raw-request-fullscreen";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "element-fullscreen",
  rules: {
    "no-raw-request-fullscreen": noRawRequestFullscreen,
  },
} satisfies LintContribution;

import noPageTransport from "./no-page-transport";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "networking",
  rules: {
    "no-page-transport": noPageTransport,
  },
} satisfies LintContribution;

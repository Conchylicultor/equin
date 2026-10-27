import noPageTransport from "./no-page-transport";
import noRequestGuardCapability from "./no-request-guard-capability";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "networking",
  rules: {
    "no-page-transport": noPageTransport,
    "no-request-guard-capability": noRequestGuardCapability,
  },
  noDebt: ["no-page-transport", "no-request-guard-capability"],
} satisfies LintContribution;

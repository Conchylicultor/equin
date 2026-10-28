import noOriginHeaderRead from "./no-origin-header-read";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

/**
 * Lint barrel for the principal: one rule, keeping the "who is calling?"
 * question at the edge (the gateway's verdict, the route's declared access)
 * and out of individual handlers.
 */
export default {
  name: "principal",
  rules: {
    "no-origin-header-read": noOriginHeaderRead,
  },
} satisfies LintContribution;

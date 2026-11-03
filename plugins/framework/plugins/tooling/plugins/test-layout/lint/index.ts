import bunSyncSettleMatchers from "./bun-sync-settle-matchers";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "test-layout",
  rules: {
    "bun-sync-settle-matchers": bunSyncSettleMatchers,
  },
} satisfies LintContribution;

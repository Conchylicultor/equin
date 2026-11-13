import noRssMemory from "./no-rss-memory";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "process-memory",
  rules: {
    "no-rss-memory": noRssMemory,
  },
} satisfies LintContribution;

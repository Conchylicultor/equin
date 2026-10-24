import noBareCargo from "./no-bare-cargo";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "rust",
  rules: {
    "no-bare-cargo": noBareCargo,
  },
} satisfies LintContribution;

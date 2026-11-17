import noRawTextInput from "./no-raw-text-input";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

/**
 * Lint barrel for kept state: every text field goes through a text-input
 * primitive, whose required `keep` decides whether its text survives a reload
 * (research/2026-11-17-global-lossless-reload.md, "Enforcement").
 */
export default {
  name: "kept-state",
  rules: {
    "no-raw-text-input": noRawTextInput,
  },
} satisfies LintContribution;

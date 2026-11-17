import noBlobInState from "./no-blob-in-state";
import noRawTextInput from "./no-raw-text-input";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

/**
 * Lint barrel for kept state: every text field goes through a text-input
 * primitive, whose required `keep` decides whether its text survives a reload
 * (research/2026-11-17-global-lossless-reload.md, "Enforcement"), and no blob
 * is held in React state, where a reload loses it.
 */
export default {
  name: "kept-state",
  rules: {
    "no-raw-text-input": noRawTextInput,
    "no-blob-in-state": noBlobInState,
  },
} satisfies LintContribution;

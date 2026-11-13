import perRunMemo from "./per-run-memo";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "shared-work-safety",
  rules: {
    // A per-run memo (keyed by a run's file set) is a sharedMemo.
    "per-run-memo": perRunMemo,
  },
  outOfScope: {
    "per-run-memo": ["research", "generated"],
  },
} satisfies LintContribution;

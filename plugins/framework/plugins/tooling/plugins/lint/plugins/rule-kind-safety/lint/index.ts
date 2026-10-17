import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import typeAwareRuleDeclared from "./type-aware-rule-declared";

export default {
  name: "rule-kind-safety",
  rules: {
    "type-aware-rule-declared": typeAwareRuleDeclared,
  },
} satisfies LintContribution;

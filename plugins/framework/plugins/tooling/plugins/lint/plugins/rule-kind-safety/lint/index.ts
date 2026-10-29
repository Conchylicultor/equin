import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import noRawRuleCreator from "./no-raw-rule-creator";
import typeAwareRuleDeclared from "./type-aware-rule-declared";

export default {
  name: "rule-kind-safety",
  rules: {
    "no-raw-rule-creator": noRawRuleCreator,
    "type-aware-rule-declared": typeAwareRuleDeclared,
  },
} satisfies LintContribution;

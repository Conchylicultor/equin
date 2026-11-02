import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import noPluginPathRegex from "./no-plugin-path-regex";
import noRawRuleCreator from "./no-raw-rule-creator";
import noRawRuleTester from "./no-raw-rule-tester";
import typeAwareRuleDeclared from "./type-aware-rule-declared";

export default {
  name: "rule-kind-safety",
  rules: {
    "no-plugin-path-regex": noPluginPathRegex,
    "no-raw-rule-creator": noRawRuleCreator,
    "no-raw-rule-tester": noRawRuleTester,
    "type-aware-rule-declared": typeAwareRuleDeclared,
  },
  // Only test files build a RuleTester — the files contributed rules skip by
  // default.
  enforceEverywhere: ["no-raw-rule-tester"],
} satisfies LintContribution;

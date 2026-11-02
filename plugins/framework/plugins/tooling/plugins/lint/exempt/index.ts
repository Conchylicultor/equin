import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/declared-utilities.ts", "core/plugin-dirs.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "rule-kind-safety/no-raw-rule-creator",
    paths: ["core/rule-creator.ts"],
    kind: "sanctioned",
    reason:
      "lintRuleCreator itself: the one place ESLintUtils.RuleCreator is called",
  },
  {
    rule: "rule-kind-safety/no-raw-rule-tester",
    paths: ["core/testing/rule-tester.ts"],
    kind: "sanctioned",
    reason:
      "createRuleTester itself: the one subclass of eslint's RuleTester, wiring bun's describe/it and a fresh project service per typed suite",
  },
] satisfies Exemptions;

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
  {
    rule: "repo-walk-safety/no-adhoc-repo-listing",
    paths: ["core/ide-lint-config.ts"],
    kind: "sanctioned",
    reason:
      "The editor's ESLint config is its own pass: ESLint loads it once per session, and its exemption manifests are read off that one listing.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/ide-lint-config.ts"],
    kind: "sanctioned",
    reason:
      "Not host code: loaded by path only by the root eslint.config.ts, inside the editor's ESLint process (Node), never through a barrel. It lists the manifests with node:child_process because infra/spawn's runner is Bun-only, and the editor's ESLint is a Node process.",
  },
  {
    rule: "blocking-fs/sync-named",
    paths: ["core/declared-utilities.ts", "core/plugin-dirs.ts"],
    kind: "sanctioned",
    reason:
      "Host tooling only: no backend loads this module (blocking-fs:sync-named-reach measures the backends' import graph), so its blocking helpers hold only the CLI's, a check's or a script's own thread.",
  },
] satisfies Exemptions;

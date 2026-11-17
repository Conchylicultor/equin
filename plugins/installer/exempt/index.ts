import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "paths:no-hardcoded-paths",
    paths: ["core/internal/report.test.ts"],
    kind: "sanctioned",
    reason:
      "Fixtures of what a person's machine prints (home-folder paths with an account name): the test holds that redactPaths turns home folders into `~`. Nothing resolves them.",
  },
] satisfies Exemptions;

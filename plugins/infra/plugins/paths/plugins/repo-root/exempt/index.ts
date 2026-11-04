import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "user-path/no-unproven-claim",
    paths: ["core/internal/repo-root.ts"],
    kind: "sanctioned",
    reason:
      "The checkout this code runs from — the app's own source tree — read off this module's own URL: the claim every REPO_ROOT-joined AppPath rests on.",
  },
] satisfies Exemptions;

import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "page-hosts-on-demand",
    paths: ["web/index.ts"],
    kind: "debt",
    reason:
      "Should serve each scope: a draft's attachment holds belong on the server of the scope that wrote it (on main's /demo they reach main's server today). Until then it is absent from the standalone website, where the demo worker's orphan sweep reclaims unheld uploads after an hour.",
    task: "task-1794361892-0zu6pf",
  },
] satisfies Exemptions;

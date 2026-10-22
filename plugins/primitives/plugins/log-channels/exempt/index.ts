import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "networking/no-page-transport",
    paths: ["web/client-log.ts"],
    kind: "sanctioned",
    reason:
      "Page-wide telemetry: clientLog persists to the page's own worktree logs, whatever subtree logged (D3).",
  },
] satisfies Exemptions;

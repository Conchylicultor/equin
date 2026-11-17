import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/bundle.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason:
      "not yet split into server/ + machine/: a server/ barrel because its callers launch daemons from server/ (infra/mcp/browser's host client, like defineDaemon itself)",
  },
] satisfies Exemptions;

import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "db-connection/no-raw-pg-connection",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "The sanctioned construction site: the connection plugin IS where the deadline-bearing pool and client are built.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/client.ts", "server/internal/deadline.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;

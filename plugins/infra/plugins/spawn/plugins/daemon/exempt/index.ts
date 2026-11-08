import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "daemon/no-raw-worker",
    paths: ["."],
    kind: "sanctioned",
    reason: "The daemon primitive itself is where the one `new Worker` lives.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/registry.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;

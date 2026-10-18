import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "imperative-create-table-allowlisted",
    paths: ["check/imperative-create-table-allowlisted.ts"],
    kind: "sanctioned",
    reason:
      "The check's own source: its description, message and hint strings spell out the token it greps for.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "core/internal/drizzle-stage.ts",
      "core/internal/published-immutable.ts",
      "core/internal/schema-load-probe.ts",
      "core/internal/snapshot-dag.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;

import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "product-name:legacy-id",
    paths: ["data"],
    kind: "sanctioned",
    reason:
      "Committed migrations are history: their SQL carries the kept migration marker and DB object names verbatim, and rewriting a published migration changes its hash.",
  },
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
      "core/internal/schema-snapshot.ts",
      "core/internal/snapshot-bodies.ts",
      "core/internal/snapshot-dag.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "check-thread-safety/no-blocking-check-work",
    paths: [
      "check/fork-schema-drift.ts",
      "check/internal/declared-schema-inputs.ts",
      "check/migration-phases-valid.ts",
      "check/orphaned-tables.ts",
    ],
    kind: "debt",
    task: "task-1793375830-dv7cez",
    reason:
      "Per-file synchronous work on the shared check thread (a blocking fs/process call made per item, or a direct maskSource / createSourceFile) that predates the rule; move it onto ctx.repo() / fs/promises and checks/core's maskedSource / parsedTsSource.",
  },
] satisfies Exemptions;

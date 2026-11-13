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
      "core/internal/schema-glob.ts",
      "core/internal/drizzle-stage.ts",
      "core/internal/published-immutable.ts",
      "core/internal/schema-load-probe.ts",
      "core/internal/schema-snapshot.ts",
      "core/internal/snapshot-bodies.ts",
      "core/internal/migration-data.ts",
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
  {
    rule: "blocking-fs/sync-named",
    paths: [
      "core/internal/drizzle-stage.ts",
      "core/internal/schema-snapshot.ts",
    ],
    kind: "sanctioned",
    reason:
      "Host tooling only: no backend loads this module (blocking-fs:sync-named-reach measures the backends' import graph), so its blocking helpers hold only the CLI's, a check's or a script's own thread.",
  },
  {
    rule: "sql-writes:fit:hand-written",
    paths: ["server/internal/runner.ts"],
    kind: "sanctioned",
    reason:
      "The migration runner's own ledger table is written while the schema it records is being applied — before any table definition is known to hold — by the runner that owns that table.",
  },
] satisfies Exemptions;

import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "jobs:no-raw-addjob",
    paths: ["server/internal/cron-dedup.ts"],
    kind: "sanctioned",
    reason:
      "The cron-dedup regression harness: inserts a row under a literal job key an hour ahead, asserts graphile's upsert behaviour under the cron path's `job_key` / `job_key_mode`, and removes it. Driving `add_job` directly avoids a permanently-installed `* * * * *` schedule and a multi-minute wait.",
  },
  {
    rule: "endpoints:no-raw-json-handlers",
    paths: ["server/internal", "machine/internal"],
    kind: "sanctioned",
    reason:
      "Long-poll / onDeadline test handlers with custom statuses and timeouts.",
  },
  {
    rule: "ids:pk-declared",
    paths: ["server/internal/tables.ts"],
    kind: "debt",
    task: "task-1791405297096-jyzsmk",
    reason:
      "A trigger table built by infra/events' defineTriggerEvent, whose shared column set (events/server/internal/base-columns.ts) keys every *_triggers table by a bare uuid. Phase 6 of the unified prefixed ids keys them all at once (uuid -> text + a declared kind) in that one file; delete this entry then.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/serial-queue.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "sql-writes:fit:schema",
    paths: [
      "machine/internal/crash-recovery.ts",
      "machine/internal/queue-lock-no-steal.ts",
      "machine/internal/superseded.ts",
    ],
    kind: "sanctioned",
    reason:
      "Drives graphile-worker's own tables (graphile_worker._private_*) to stage crash and lock scenarios; those tables come from graphile-worker's migrations, not from a declaration in this repo.",
  },
  {
    rule: "sql-writes:fit:hand-written",
    paths: [
      "machine/internal/crash-recovery.ts",
      "machine/internal/queue-lock-no-steal.ts",
      "machine/internal/superseded.ts",
    ],
    kind: "sanctioned",
    reason:
      "The harnesses stage a stuck or superseded graphile row by writing graphile-worker's own tables (graphile_worker._private_*), which graphile's migrations create and this repo declares no typed table for.",
  },
] satisfies Exemptions;

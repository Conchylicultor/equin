import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "timer/no-unlisted-timer",
    paths: ["server/internal/stuck-lock-sweeper.ts"],
    kind: "sanctioned",
    reason:
      "The job queue's own recovery: a queued sweeper could not run while the wedged worker it exists to free holds the queue.",
  },
  {
    rule: "jobs:no-raw-addjob",
    paths: ["server/internal/registry.ts", "check/index.ts"],
    kind: "sanctioned",
    reason:
      "The one file that inserts a jobs.run row (everything else goes through `job.enqueue`), and this check, which names every banned token to describe it.",
  },
  {
    rule: "jobs:no-raw-addjob",
    paths: ["server/internal/enqueue-deadline.test.ts"],
    kind: "sanctioned",
    reason:
      "Not an enqueue path: proves graphile's insert, through a `jobs-enqueue` pool whose connection stops answering, rejects with the connection deadline. `job.enqueue` cannot drive that, and the bytes are dropped on a throwaway database so no row lands.",
  },
  {
    rule: "jobs:no-raw-addjob:task-literal",
    paths: ["core/hold.ts", "check/index.ts"],
    kind: "sanctioned",
    reason:
      "`core/hold.ts` declares the legacy task identifier (`LEGACY_JOB_TASK`) everyone else imports; the check names it to ban it.",
  },
  {
    rule: "ids:pk-declared",
    paths: ["server/internal/tables.ts"],
    kind: "debt",
    task: "task-1791405297096-jyzsmk",
    reason:
      "Phase-1 baseline of the unified prefixed ids: this table's `id` primary key names no id kind yet. Declare the kind (`defineIdKind`) and key the table with `idColumn` / `idKindField` (or `externalIdColumn` for an id minted elsewhere) in its migration phase, then delete this entry.",
  },
  {
    rule: "no-db-backed-notify",
    paths: ["server/internal/resources.ts"],
    kind: "sanctioned",
    reason:
      "`jobs-list` reads graphile-worker's own tables (`graphile_worker.*`), a schema the DB change feed deliberately leaves out (only `public` gets triggers), so the feed can never invalidate it; the queue-activity signal (`onQueueActivity`) notifies it instead.",
  },
] satisfies Exemptions;

import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "timer/no-unlisted-timer",
    paths: ["machine/internal/stuck-lock-sweeper.ts"],
    kind: "sanctioned",
    reason:
      "The job queue's own recovery: a queued sweeper could not run while the wedged worker it exists to free holds the queue.",
  },
  {
    rule: "jobs:no-raw-addjob",
    paths: ["machine/internal/graphile-queue.ts", "check/index.ts"],
    kind: "sanctioned",
    reason:
      "The one file that inserts a jobs.run row (the desktop queue's `JobQueue.enqueue`; everything else goes through `job.enqueue`), and this check, which names every banned token to describe it.",
  },
  {
    rule: "jobs:no-raw-addjob",
    paths: ["machine/internal/enqueue-deadline.test.ts"],
    kind: "sanctioned",
    reason:
      "Not an enqueue path: proves graphile's insert, through a `jobs-enqueue` pool whose connection stops answering, rejects with the connection deadline. `job.enqueue` cannot drive that, and the bytes are dropped on a throwaway database so no row lands.",
  },
  {
    rule: "jobs:no-raw-addjob",
    paths: ["machine/internal/graphile-completion-patch.test.ts"],
    kind: "sanctioned",
    reason:
      "Not an enqueue path: proves `patches/graphile-worker@0.18.0.patch` by driving a bare graphile runner on a throwaway database, with its own task list and a faulty pool. `job.enqueue` reaches only the app's own runners.",
  },
  {
    rule: "jobs:no-raw-addjob",
    paths: ["machine/internal/queue-wake.test.ts"],
    kind: "sanctioned",
    reason:
      "Not an enqueue path: proves the queue wake by driving bare graphile runners (poll off) on a throwaway database with future-dated, failing and serial-lane rows. `job.enqueue` reaches only the app's own runners.",
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
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/queue-schema.ts",
      "server/internal/superseded-trigger.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason:
      "graphile's schema install stays in server/ (reached only from server/testing and the machine queue, never from the server barrel) because DB test suites in other plugins' server/ folders install it on throwaway databases, and test code follows its folder's row; move it once those suites can reach a machine testing barrel.",
  },
  {
    rule: "sql-writes:fit:schema",
    paths: [
      "machine/internal/dead-job-gc.ts",
      "machine/internal/graphile-queue.ts",
      "machine/internal/introspection.ts",
      "machine/internal/stuck-lock-sweeper.ts",
      "machine/internal/worker.ts",
    ],
    kind: "sanctioned",
    reason:
      "Writes graphile-worker's own tables (graphile_worker._private_*), created by graphile-worker's migrations rather than declared in this repo, so the check cannot know their columns. The jobs plugin owns the graphile integration.",
  },
] satisfies Exemptions;

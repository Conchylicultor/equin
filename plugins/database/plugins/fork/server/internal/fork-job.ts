import { z } from "zod";
import { NonRetryableError } from "@plugins/infra/plugins/jobs/server";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { fileReportFromProcess } from "@plugins/reports/plugins/outbox/core";
import {
  describeUndeclaredSchema,
  forkDatabase,
  ForkPlanError,
  forkExclusions,
} from "@plugins/database/plugins/admin/server";
import type { ForkOutcome } from "@plugins/database/plugins/admin/server";
import {
  DB_FORK_FAILED_KIND,
  FORK_UNDECLARED_SCHEMA_KIND,
} from "./report-kinds";

// The fork's transcript, at `logs/database-fork.jsonl` of the backend that
// supervises it. Its only writer is that backend, tailing the child's output;
// the child evaluates this module too (exec mode boots the plugin graph) but
// never publishes, and the file sink is only built on first publish.
const forkLog = defineLogSink({
  id: "database-fork",
  description:
    "Worktree DB fork transcript: pg_dump | pg_restore of main's DB into a new worktree's database, and its outcome.",
});

// Durable, self-healing worktree DB fork, run in a detached child
// (`./singularity supervised-exec database.fork`). A restart or deploy of the
// backend no longer interrupts a `pg_dump | pg_restore` in flight: the child
// keeps going and whichever backend is alive when it exits records the outcome.
//
// `lock: target` — the built-in ledger's open row for this target is the
// in-flight lock, so a second enqueue for the same worktree loses its claim
// while a fork runs. `forkDatabase` is idempotent (no-op once the canonical DB
// exists) and atomic-publish, so a retry is safe; `runAttempts: 5` retries a
// failed fork with a durable backoff (~3, 7, 20, 55 s) between attempts.
//
// Lives in its own `database/fork` plugin rather than `database/admin` because
// `infra/jobs` already depends on `database/admin` (for `connectionString`);
// putting a job consumer back in `admin` would form an import cycle.
export const databaseForkJob = defineSupervisedJob({
  name: "database.fork",
  description:
    "Copies the main database into a new worktree's own database so the worktree starts with current data.",
  input: z.object({ source: z.string(), target: z.string() }),
  channel: forkLog,
  lock: (input) => input.target,
  runAttempts: 5,
  async run({ source, target }, { log }) {
    log(`fork ${source} → ${target}: starting`);
    // Only the fork itself is inside the try: a failure to raise a bell about
    // what the fork FOUND must never be reported as the fork having failed.
    let outcome: ForkOutcome;
    try {
      // Read the declared exclusion set here, inside a booted runtime, where
      // server contributions have been collected. `forkExclusions()` throws
      // rather than returning an empty set, so a process that never booted can
      // never quietly fork everything.
      outcome = await forkDatabase(source, target, forkExclusions());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`fork ${source} → ${target} failed: ${message}`, "stderr");
      // Through the OUTBOX, not `recordReport`: this body runs in the
      // supervised child, whose per-process report-engine memory (velocity,
      // fan-out, shed buffer) would die with it. Main's drain records it.
      await fileReport(
        {
          kind: DB_FORK_FAILED_KIND,
          message: `DB fork ${source} → ${target} failed: ${message}`,
          data: {
            source,
            target,
            planError: err instanceof ForkPlanError,
            error: err instanceof Error && err.stack ? err.stack : message,
          },
        },
        log,
      );
      // A refusal from the fork PLAN is deterministic — the same declarations
      // against the same catalog fail identically every time — so it
      // dead-letters after this one attempt instead of re-running a 2 GB dump
      // four more times and re-notifying on each. It is still loud, still a
      // dead-letter in Debug → Queue; the fix is a contribution edit, not a
      // retry.
      if (err instanceof ForkPlanError) throw new NonRetryableError(message);
      // Everything else may be transient (a busy cluster) and retries.
      throw err;
    }
    log(`fork ${source} → ${target}: ${outcome.kind}`);

    // A schema nobody claimed means main's rows for it are now in this fork, and
    // in every fork after it. Not worth failing a fork over (see
    // `ForkPlan.undeclaredSchemas` for why refusing would be the worse trade),
    // but very much worth a human deciding — so it reaches the bell rather than
    // only a log nobody reads. Deduped per SCHEMA, not per fork, so it appears
    // once and stays until dismissed instead of once per worktree.
    if (outcome.kind !== "forked") return;
    for (const s of outcome.plan.undeclaredSchemas) {
      log(`undeclared schema: ${describeUndeclaredSchema(s)}`, "stderr");
      await fileReport(
        {
          kind: FORK_UNDECLARED_SCHEMA_KIND,
          message: `Schema not covered by any fork exclusion: ${describeUndeclaredSchema(s)}`,
          data: {
            schema: s.schema,
            description: describeUndeclaredSchema(s),
            target,
          },
        },
        log,
      );
    }
  },
});

// `fileReportFromProcess` never throws and has already printed why when it did
// not write; say the consequence into the fork's own transcript too.
async function fileReport(
  report: Parameters<typeof fileReportFromProcess>[0],
  log: (line: string, stream?: "stderr") => void,
): Promise<void> {
  const result = await fileReportFromProcess(report);
  if (result.outcome !== "written") {
    log(
      `${report.kind} report could not be filed (${result.outcome})`,
      "stderr",
    );
  }
}

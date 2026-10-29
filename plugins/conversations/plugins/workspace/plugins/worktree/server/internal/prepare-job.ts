import { z } from "zod";
import { getConfig } from "@plugins/config_v2/server";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { setupWorktree } from "@plugins/infra/plugins/worktree/server";
import { spareRefillJob } from "@plugins/infra/plugins/worktree/plugins/spare-pool/server";
import { compositionsConfig } from "@plugins/plugin-meta/plugins/composition/core";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";

// The checkout's transcript, at `logs/worktree-prepare.jsonl` of the backend
// that supervises it (its only writer, tailing the child's output).
const prepareLog = defineLogSink({
  id: "worktree-prepare",
  description:
    "Agent checkout transcript: claiming a spare or adding a fresh git worktree for a launch, then installing it.",
});

/**
 * Makes an attempt's checkout, in a detached child
 * (`./equin supervised-exec worktree.prepare`) a backend restart does not kill.
 * The spawn job requests it and waits (`prepareWorktree`), so a deploy landing
 * mid-checkout no longer cuts a `git worktree add` half-way: the child finishes
 * and whichever backend is alive when it ends resumes the spawn.
 *
 * `lock: attemptId` — the built-in ledger's open row is the in-flight lock, so
 * a second request for the same checkout loses its claim while one runs, and
 * it is how the spawn finds the run it waits on (`latestSupervisedRun`).
 * `runAttempts` stays 1: the spawn owns the retry ladder (a re-request), and a
 * failed run dead-letters here — loud, beside the spawn's own report.
 */
export const worktreePrepareJob = defineSupervisedJob({
  name: "worktree.prepare",
  description:
    "Checks out a new agent's git worktree (from a spare, or fresh) and installs it, in a process of its own so a restart does not interrupt it.",
  input: z.object({ attemptId: z.string(), path: z.string() }),
  channel: prepareLog,
  lock: (input) => input.attemptId,
  // Each child boots the plugin graph and opens database connections through
  // the host-wide pgbouncer, and a launch storm requests one per launch at
  // once: past the pool's size a child waits for a slot BEFORE it boots,
  // holding nothing. Its row is open meanwhile, so the spawn keeps waiting on
  // it (`prepareWorktree`) — a queued checkout is not a failed one.
  admission: "worktree-prepare",
  // No signal: the child is bounded by git's own timeouts and install's, and
  // nothing else holds it.
  async run({ attemptId, path }, { log }) {
    // A checkout claims the namespace of its own name, so `setupWorktree`
    // refuses one a composition already holds. The manifest is read through
    // the config registry here (the child boots the plugin graph, config
    // included) rather than inside `infra/worktree`, which must stay importable
    // from the CLI.
    log(`checkout ${attemptId} at ${path}: starting`);
    const { source } = await setupWorktree(
      attemptId,
      path,
      new Set(getConfig(compositionsConfig).manifests.map((m) => m.id)),
    );
    log(`checkout ${attemptId}: ${source}`);
  },
  // A checkout was made — from a spare (the pool is now one short) or cold
  // (the pool was empty) — so top the pool back up for the next launch. Here
  // rather than in the child, which never enqueues; idempotent (the refill is
  // one job-wide run).
  async onEnded(_runId, terminal) {
    if (terminal.exitCode === 0) await spareRefillJob.enqueue({});
  },
});

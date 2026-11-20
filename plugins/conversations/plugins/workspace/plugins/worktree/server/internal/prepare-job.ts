import { z } from "zod";
import { getConfig } from "@plugins/config_v2/server";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import {
  describeAdoption,
  describeSetupStep,
  describeTreeStart,
  recordSetupSteps,
  setupWorktree,
} from "@plugins/infra/plugins/worktree/server";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { spareRefillJob } from "@plugins/infra/plugins/worktree/plugins/spare-pool/server";
import { compositionsConfig } from "@plugins/plugin-meta/plugins/composition/core";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import {
  markCheckoutBooted,
  markCheckoutEnded,
} from "@plugins/conversations/plugins/launch-timeline/server";
import type { CheckoutStep } from "@plugins/conversations/plugins/launch-timeline/core";
import { checkoutProgress } from "./tables-checkout-progress";

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
  input: z.object({
    attemptId: z.string(),
    path: z.string(),
    // The launch whose record the child marks (launch-timeline). Absent on a
    // run requested before the field existed: it marks nothing.
    conversationId: z.string().optional(),
  }),
  channel: prepareLog,
  lock: (input) => input.attemptId,
  // Each child boots the plugin graph and opens database connections through
  // the host-wide pgbouncer, and a launch storm requests one per launch at
  // once: past the pool's size a child waits for a slot BEFORE it boots,
  // holding nothing. Its row is open meanwhile, so the spawn keeps waiting on
  // it (`prepareWorktree`) — a queued checkout is not a failed one.
  admission: "worktree-prepare",
  // Its child starts this plugin and what it imports, not the whole app (an
  // agent launch waits on it): the checkout reads no contributed list.
  reads: [],
  // No signal: the child is bounded by git's own timeouts and install's, and
  // nothing else holds it.
  async run({ attemptId, path, conversationId }, { log }) {
    // A checkout claims the namespace of its own name, so `setupWorktree`
    // refuses one a composition already holds. The manifest is read through
    // the config registry here (the child boots the plugin graph, config
    // included) rather than inside `infra/worktree`, which must stay importable
    // from the CLI.
    log(`checkout ${attemptId} at ${path}: starting`);
    // The launch record (launch-timeline): when this process started — before
    // its worktree-prepare slot wait and its boot — and when its body began.
    // Written before the checkout, so a hung one shows it got this far.
    if (conversationId !== undefined)
      await markCheckoutBooted(conversationId, {
        childStartedAt: Math.round(performance.timeOrigin),
        bootedAt: Date.now(),
      });
    // Each step as it ends (a hung one shows where it hung), then the whole
    // split on the result line — the record every launch leaves of where its
    // checkout's time went — and on the launch record, placed by its end.
    const ended: CheckoutStep[] = [];
    const steps = recordSetupSteps((s) => {
      ended.push({ ...s, endAt: Date.now() });
      log(`checkout ${attemptId} step: ${describeSetupStep(s)}`);
    });
    const { source, tree, depStore, fsmonitor, untrackedCache } =
      await setupWorktree(
        attemptId,
        path,
        new Set(getConfig(compositionsConfig).manifests.map((m) => m.id)),
        // This backend: its database is where the attempt row lives.
        runtimeNamespace(),
        steps.onStep,
        // The files are there: the spawn waiting on them starts its agent now,
        // while this child installs (`prepareWorktree`'s `filesReady`). The
        // child's one enqueue (the spawn's `jobs.resume`, as an exec child may:
        // jobs' queue-stamp part). Thrown when it fails, like this child's
        // launch-record writes: a database this child cannot write to fails
        // its run, which the spawn requests again.
        async () => {
          log(`checkout ${attemptId}: files written`);
          await checkoutProgress.emit({ attemptId });
        },
      );
    if (conversationId !== undefined)
      await markCheckoutEnded(conversationId, {
        endedAt: Date.now(),
        steps: ended,
        source,
      });
    log(
      `checkout ${attemptId}: ${source}; ${tree === null ? "" : `${describeTreeStart(tree)}; `}${describeAdoption(depStore)}; fsmonitor: ${typeof fsmonitor === "string" ? fsmonitor : "kind" in fsmonitor ? `FAILED (${fsmonitor.error})` : `${fsmonitor.daemon}, token ${fsmonitor.token.kind}`}; untracked cache: ${untrackedCache}; steps: ${steps.summary()}`,
    );
  },
  // A checkout was made — from a spare (the pool is now one short) or cold
  // (the pool was empty) — so top the pool back up for the next launch. Here
  // rather than in the child, which enqueues nothing but the one wake-up
  // (`checkoutProgress`, its files written); idempotent (the refill is one
  // job-wide run).
  //
  // Whatever the outcome, the attempt's checkout moved: a spawn still waiting
  // for its files (a run that failed before writing them) looks again now
  // rather than at its wait's timeout.
  async onEnded(_runId, terminal, { input }) {
    await checkoutProgress.emit({ attemptId: input.attemptId });
    if (terminal.exitCode === 0) await spareRefillJob.enqueue({});
  },
});

import { z } from "zod";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import {
  countReadySpares,
  createSpareWorktree,
  pruneSpares,
} from "@plugins/infra/plugins/worktree/server";

/**
 * How many ready spares the pool keeps. One covers the common case (one launch
 * at a time); concurrent launches beyond it fall back to the cold
 * `git worktree add` (~5 s with parallel checkout), and each launch enqueues a
 * refill afterwards.
 */
const SPARE_TARGET = 1;

// The refill's transcript, at `logs/worktree-spare-refill.jsonl` of the backend
// that supervises it (its only writer, tailing the child's output).
const refillLog = defineLogSink({
  id: "worktree-spare-refill",
  description:
    "Spare worktree refill transcript: pruning spare debris and writing (and installing) a ready checkout of main.",
});

/**
 * Tops the spare pool back up: reclaims spare debris (a refill or claim killed
 * mid-way) and over-age spares, then writes spares until `SPARE_TARGET` are
 * ready. Enqueued after every launch's checkout, at main's boot, and daily.
 *
 * Supervised, so the checkout and its install run in a detached child
 * (`./equin supervised-exec worktree.spare-refill`) a backend restart does not
 * kill — an in-process refill died with every deploy and left a cut-off add
 * behind. Built-in ledger with no `lock`: one run of the job at a time, so an
 * enqueue while one runs loses its claim and returns — the running loop tops up
 * to `SPARE_TARGET` anyway.
 */
export const spareRefillJob = defineSupervisedJob({
  name: "worktree.spare-refill",
  description:
    "Keeps a ready checkout of main on standby, so launching an agent claims it instead of writing a fresh checkout while you wait.",
  input: z.object({}),
  channel: refillLog,
  // Daily: replaces a spare older than a day, so the one a claim takes is never
  // weeks behind `main`.
  schedule: { cron: "40 4 * * *" },
  // No signal: the child is bounded by git's own timeouts and install's, and
  // nothing else holds it.
  async run(_input, { log }) {
    const pruned = await pruneSpares();
    if (pruned.length > 0) log(`pruned ${pruned.join(", ")}`);
    while ((await countReadySpares()) < SPARE_TARGET) {
      await createSpareWorktree();
      log("wrote a ready spare");
    }
  },
});

/** Fills the pool at main's boot, so the first launch after a restart claims a spare. */
export const spareRefillWarmup = defineWarmup({
  name: "worktree.spare-refill",
  description:
    "Queues a spare checkout of main at startup, so the first agent launched after a restart starts without waiting for a checkout.",
  scope: "host",
  run: async () => {
    await spareRefillJob.enqueue({});
  },
});

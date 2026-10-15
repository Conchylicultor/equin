import { z } from "zod";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { fileReportFromProcess } from "@plugins/reports/plugins/outbox/core";
import { WorktreeGitTimeoutError } from "@plugins/infra/plugins/worktree/server";
import { reclaimNamespace } from "@plugins/infra/plugins/worktree/plugins/reclaim/server";
import {
  collectReapable,
  type NamespaceReapTarget,
  type ReapTarget,
} from "./reap-policy";
import { reapAttempt } from "./reap";

// The reaper's ops log, at `logs/worktree-cleanup.jsonl`. Its only WRITER is the
// backend that supervises a sweep: it tails the child's transcript into this
// channel. The child evaluates this same module (exec mode boots the plugin
// graph), which registers the channel in the child's own in-memory registry —
// harmless, because the file sink is built lazily on first publish and the
// child never publishes; it only writes lines through `log`.
const reapLog = defineLogSink({
  id: "worktree-cleanup",
  description:
    "Worktree-cleanup reaper ops log: stale git worktree + Postgres DB-fork removals.",
});

// Run `fn` over `items` with at most `limit` concurrent executions.
async function pMap<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      await fn(items[i]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

// Automatic reaper for stale worktrees + orphaned fork DBs. Runs hourly on the
// main runtime only (no perWorktree) — DBs are a global cluster resource, so a
// single sweep covers all worktrees (mirrors database.fork-temp-sweep).
//
// The sweep runs in a detached child (`./singularity supervised-exec`), so a
// deploy or restart of the backend no longer kills it part-way, and no worker
// slot is held for its length. The built-in ledger's job-wide lock keeps it to
// one sweep at a time: an hourly tick or the boot enqueue that lands while a
// sweep is in flight loses its claim and returns.
//
// `runAttempts: 1`: the sweep is idempotent and the next hourly tick IS the
// retry, so a failed sweep dead-letters once (Debug → Queue) instead of
// re-running straight away.
//
// Per-target failures are contained (logged + reported, not re-thrown): one
// corrupt fork must not block the rest.
export const worktreeReapJob = defineSupervisedJob({
  name: "worktree-cleanup.reap-stale",
  description:
    "Reclaims stale worktrees and orphaned forked databases, and reports any that could not be cleaned up.",
  input: z.object({}),
  channel: reapLog,
  schedule: { cron: "0 * * * *" }, // hourly
  runAttempts: 1,
  async run(_input, { log }) {
    const scan = await collectReapable(Date.now());
    const targets = scan.targets;
    const namespaceTargets = scan.namespaceTargets;
    let reaped = 0;
    let reclaimed = 0;

    // The scan's own shape, logged every tick. `scanned` vs `candidates` shows
    // how much of the attempt table has nothing left to reclaim (the cost the
    // readdir inversion removed), and `hygieneProbes` is K — the residual git
    // fan-out. K is what decides whether a negative hygiene cache is worth any
    // state at all; if it stays single-digit, the answer is no.
    log(
      `auto-reap scan: scanned=${scan.scanned} candidates=${scan.candidates} hygieneProbes=${scan.hygieneProbes} targets=${targets.length} namespaceTargets=${namespaceTargets.length}`,
    );

    // Failures of the REPORTING path, not of a reap. Collected rather than
    // thrown where they happen, and re-thrown once the sweep is over — see the
    // filing below and the throw at the end of the body.
    const reportFailures: string[] = [];

    // One containment, both passes. A failure here is CONTAINED — one corrupt
    // fork or one undroppable database must not block the rest of the sweep, and
    // the sweep is idempotent, so the next hourly run retries whatever this one
    // could not reclaim — but containment must not mean silence. The log channel
    // nobody tails was the entire alerting story for the single most important
    // signal these bounds produce: a git child killed while holding a host-wide
    // `worktree-mutate` slot, i.e. the 2026-08-17 outage caught in the act. So
    // every contained failure also files a report, which reaches Debug → Reports
    // and the bell.
    const contain = async (
      targetId: string,
      work: () => Promise<void>,
    ): Promise<void> => {
      try {
        await work();
      } catch (err) {
        log(`reap ${targetId} failed: ${String(err)}`, "stderr");
        // `timedOut` is read from the ERROR'S TYPE, never from its message: the
        // throw site knows for certain whether it killed a child, and a report
        // that fingerprints a wedge apart from an ordinary failure must not rest
        // on string matching.
        const wedge = err instanceof WorktreeGitTimeoutError ? err : undefined;

        // Through the OUTBOX, not `recordReport`: this body runs in the
        // supervised child, which is not the serving backend — the reports
        // table's change producer refuses a write there (its change would reach
        // no subscriber), and the report engine's per-process memory (velocity,
        // fan-out, shed buffer) would die with the child. Main's drain records
        // it, as for the sibling jobs (fork-job, backup-body).
        const filed = await fileReportFromProcess({
          kind: "worktree-reap-failed",
          message: `reap ${targetId} failed: ${String(err)}`,
          data: {
            targetId,
            timedOut: wedge !== undefined,
            ...(wedge
              ? { command: wedge.command, timeoutMs: wedge.timeoutMs }
              : {}),
            message: String(err),
          },
        });
        if (filed.outcome !== "written") {
          // `fileReportFromProcess` never throws and has already printed why.
          // Not swallowed — parked, and re-thrown below once every target has
          // been attempted: throwing from inside this worker would abandon the
          // remaining targets, the very containment this catch exists to
          // preserve. Parking keeps the sweep whole AND the failure loud.
          reportFailures.push(
            `${targetId}: report not filed (${filed.outcome})`,
          );
        }
      }
    };

    // Per-caller cap kept ≤ the host `worktree-mutate` gate size. The host gate
    // (infra/worktree.withWorktreeMutateSlot) is now the HARD bound on concurrent
    // full-tree `git worktree remove`s across every process; this local cap keeps
    // the reap from flooding the shared flock queue with more waiters than the gate
    // can grant, always leaving headroom for an interactive spawn's checkout
    // (two-tier fairness, mirroring host-read-pool's per-worktree tier).
    await pMap(targets, 3, (t: ReapTarget) =>
      contain(t.id, async () => {
        await reapAttempt(t.id, { worktreePath: t.worktreePath });
        reaped++;
      }),
    );

    // The marker-owned namespaces, reclaimed through `reclaimNamespace` and never
    // through `reapAttempt`: these are not checkouts, there is no git worktree to
    // remove, and `reapAttempt` would resolve one from the name. Run AFTER the
    // checkout pass, which reclaims the namespaces of every checkout it reaps —
    // the scan already excludes those, and this order keeps the two from racing
    // over the same registry dir if it ever missed one.
    await pMap(namespaceTargets, 3, (t: NamespaceReapTarget) =>
      contain(t.ns, async () => {
        await reclaimNamespace(t.ns);
        reclaimed++;
      }),
    );

    log(
      `auto-reap: ${reaped}/${targets.length} reaped, ` +
        `${reclaimed}/${namespaceTargets.length} orphaned namespaces reclaimed`,
    );

    // The sweep itself is finished; now fail the run so a broken reporting path
    // is visible as a dead-lettered job (the built-in ledger records this message)
    // rather than being the second silent failure in the same body.
    if (reportFailures.length > 0) {
      throw new Error(
        `worktree reap: ${reportFailures.length} failure report(s) could not be ` +
          `filed (the sweep itself ran to completion): ${reportFailures.join("; ")}`,
      );
    }
  },
});

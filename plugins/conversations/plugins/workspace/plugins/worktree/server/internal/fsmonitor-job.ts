import { z } from "zod";
import {
  defineJob,
  NonRetryableError,
} from "@plugins/infra/plugins/jobs/server";
import { openSupervisedRuns } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { ConversationStatusSchema } from "@plugins/tasks/plugins/tasks-core/core";
import { attemptRetention } from "@plugins/tasks/plugins/tasks-core/server";
import {
  ensureMainWorktreeRoot,
  gitWorktreesDir,
  isCanonicalWorktreeName,
  isUnfinishedEntry,
  listWorktreeEntries,
} from "@plugins/infra/plugins/worktree/server";
import {
  describeFsmonitorReconcile,
  reconcileCheckoutFsmonitors,
  type FsmonitorCheckout,
} from "@plugins/infra/plugins/git/plugins/fsmonitor/server";
import { worktreePrepareJob } from "./prepare-job";

const fsmonitorLog = defineLogSink({
  id: "worktree-fsmonitor",
  description:
    "Main's and the agent checkouts' git fsmonitor daemons: one line per reconcile — how many are on, which were started, stopped or had their index token renewed, and any failure.",
});

/**
 * Keeps git's fsmonitor daemon running for main's own checkout (always) and
 * for exactly the attempt checkouts the user has not finished with
 * (`attempts_v.retained`), on main.
 *
 * Main's checkout has no `setupWorktree`: this job is its whole lifecycle —
 * the first pass turns it on (`core.fsmonitor` in
 * `.git/equin-fsmonitor.config`, included for main's git dir only), and every pass after
 * restarts its daemon if it died or runs throttled and renews its index token
 * if stale. A pass that cannot fails the job (a job-attempt-failed report).
 * Between passes a dead daemon costs today's full scans, never a wrong
 * answer: git auto-starts one, and a token it did not issue is answered
 * "everything".
 *
 * A checkout's daemon is STARTED by `setupWorktree` when its agent gets it
 * (`infra/worktree`). This job is the rest of the lifecycle:
 *
 * - **stop** — a checkout whose attempt is no longer retained (its last open
 *   conversation closed): the daemon (~12 MB) goes, and so does
 *   `core.fsmonitor` from its `config.worktree`. A `gone` (hibernated)
 *   conversation keeps its daemon: it can resume, its edited files are still
 *   read when it is opened, and 12 MB is less than the cold reads it saves.
 * - **renew** — a retained checkout whose daemon died (a reboot, a crash):
 *   started again, and its index token renewed — a token of a dead daemon
 *   turns every read into a full scan until the index is written.
 * - **orphans** — a daemon whose checkout was removed under it (the reap's
 *   rename into the trash, then the prune) is signalled.
 *
 * Triggers: a conversation turning `done` (the moment an attempt can stop
 * being retained), main's start, and every 10 minutes — a daemon dying (git
 * may auto-start one inside some caller's process group, which dies with it)
 * or resyncing (a new token under the same pid) has no change signal to
 * listen to, and a stale token costs full scans until it is renewed.
 *
 * Only checkouts whose attempt row main holds are decided: one another
 * backend minted (a worktree build's agents) is left as it is, and its daemon
 * ends with its checkout.
 *
 * Only FINISHED checkouts are touched. While an attempt's `worktree.prepare`
 * run is open, its child owns the checkout — it writes the tree, installs it,
 * then starts the fsmonitor and records its token itself (`setupWorktree`).
 * Touching it then races that child: a `config.worktree.lock` taken twice, an
 * index read before the tree write made one, and — the one that could fail a
 * launch — this pass's index publish holding `index.lock` while the child's
 * `git reset --hard` or `git switch` needs it. So a checkout whose prepare run
 * is open, or which a cut-off run left unfinished (`isUnfinishedEntry`: the
 * next run discards it), is left alone this pass. The open runs are read AFTER
 * the listing: a checkout listed whose run has closed since has ended — its
 * files final, whole or (a write cut off) unfinished. A run that failed after
 * the files (its install) leaves them whole: decided like any other, its
 * retry's setup may overlap a pass, where every fsmonitor write of the setup
 * is non-fatal. A run that never closes, or a checkout abandoned unfinished,
 * is never decided — at most one idle daemon left as it was.
 */
export const fsmonitorReconcileJob = defineJob({
  name: "worktree.fsmonitor-reconcile",
  description:
    "Keeps git's file-watching daemon running for main's own checkout and the agent checkouts still in use (so git reads there cost what changed, not every file), and stops it for the agent checkouts whose conversations are closed.",
  // Bounded spawns per checkout (each `timeoutMs`), and an index refresh
  // (~1 s, seconds cold) for each checkout whose daemon restarted — after a
  // reboot, every retained checkout's, one after the other.
  hold: "minutes",
  inProcess:
    "every step converges: a run a restart kills leaves each checkout on or off as it was, and the next run (boot, 10 minutes) continues from there",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "*/10 * * * *" },
  async run({ ctx: { signal } }) {
    // Main's attempts table is the one that says what is retained; a
    // worktree backend's fork holds a stale copy of it.
    if (runtimeNamespace() !== MAIN_WORKTREE_NAME) {
      throw new NonRetryableError(
        `[worktree.fsmonitor-reconcile] runs on main only (this is ${runtimeNamespace()}): only main's attempts table says which checkouts are retained`,
      );
    }
    const repoRoot = await ensureMainWorktreeRoot(signal);
    const worktreesDir = gitWorktreesDir(repoRoot);
    const entries = await listWorktreeEntries(repoRoot, signal);
    const main = entries[0]!;
    // An attempt's checkout is `<worktrees dir>/<attempt id>`.
    const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
    const attempts = entries.filter(
      (e) =>
        !e.prunable &&
        e.path === `${worktreesDir}/${nameOf(e.path)}` &&
        isCanonicalWorktreeName(nameOf(e.path)),
    );
    // After the listing — see the job's doc.
    const settingUp = new Set(
      (
        await openSupervisedRuns(
          worktreePrepareJob,
          attempts.map((e) => ({ attemptId: nameOf(e.path), path: e.path })),
        )
      ).map((i) => i.attemptId),
    );
    const notReady = new Set(
      attempts.filter(
        (e) => settingUp.has(nameOf(e.path)) || isUnfinishedEntry(e),
      ),
    );
    const retention = await attemptRetention(
      attempts.map((e) => nameOf(e.path)),
    );
    const checkouts: FsmonitorCheckout[] = attempts.map((e) => {
      const retained = notReady.has(e)
        ? undefined
        : retention.get(nameOf(e.path));
      return {
        path: e.path,
        gitDir: e.gitDir,
        // A checkout not set up yet is still passed, as left alone (`unknown`),
        // so its daemon is never taken for an orphan's.
        want: retained === undefined ? "unknown" : retained ? "on" : "off",
      };
    });
    // Main's own checkout (the repo root): always on (D12) — a git there (the
    // human's, a push's merge) otherwise stats its ~26k files. Decided by no
    // attempt row and set up by no prepare run, so nothing races it but a git
    // writer there, which the token renewal's compare-and-swap publish steps
    // aside for. First, so a failure elsewhere never delays it. Main's slots
    // are not here: `infra/git/fsmonitor`'s CLAUDE.md.
    const mainCheckout: FsmonitorCheckout = {
      path: main.path,
      gitDir: main.gitDir,
      want: "on",
    };
    const result = await reconcileCheckoutFsmonitors(
      [mainCheckout, ...checkouts],
      {
        orphanRoot: `${main.gitDir}/worktrees`,
        tier: "background",
        // A resume may have taken the checkout back since the read above.
        stillOff: async (c) =>
          (await attemptRetention([nameOf(c.path)])).get(nameOf(c.path)) ===
          false,
        signal,
      },
    );
    fsmonitorLog.publish(
      `${describeFsmonitorReconcile(result)}; not set up yet ${notReady.size}${notReady.size ? ` (${[...notReady].map((e) => nameOf(e.path)).join(", ")})` : ""}`,
    );
    if (result.failures.length > 0) {
      throw new Error(
        `[worktree.fsmonitor-reconcile] ${result.failures.length} checkout(s) failed:\n` +
          result.failures.map((f) => `  ${f.path}: ${f.error}`).join("\n"),
      );
    }
  },
});

/**
 * A conversation that turned `done` may have released its attempt: reconcile
 * now rather than at the next tick. The other statuses keep the attempt
 * retained (`gone` included).
 */
export const fsmonitorOnConversationEndedJob = defineJob({
  name: "worktree.fsmonitor-on-conversation-ended",
  description:
    "Asks for the agent checkouts' file-watching daemons to be reconciled when a conversation is closed, so a finished checkout's daemon stops promptly.",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z.object({ status: ConversationStatusSchema }).passthrough(),
  run: async ({ event }) => {
    if (event?.status !== "done") return;
    // A worktree backend's own conversations end too; main decides.
    if (runtimeNamespace() !== MAIN_WORKTREE_NAME) return;
    await fsmonitorReconcileJob.enqueue({});
  },
});

/**
 * A pass at main's start: after a reboot every daemon is gone and every
 * retained checkout's index names a dead one — full scans until renewed.
 */
export const fsmonitorReconcileWarmup = defineWarmup({
  name: "worktree.fsmonitor-reconcile",
  description:
    "Queues a pass over main's and the agent checkouts' file-watching daemons at startup, so after a reboot their git reads are fast again within minutes.",
  scope: "host",
  run: async () => {
    await fsmonitorReconcileJob.enqueue({});
  },
});

import { z } from "zod";
import {
  defineJob,
  NonRetryableError,
} from "@plugins/infra/plugins/jobs/server";
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
  listWorktreeEntries,
} from "@plugins/infra/plugins/worktree/server";
import {
  describeFsmonitorReconcile,
  reconcileCheckoutFsmonitors,
  type FsmonitorCheckout,
} from "@plugins/infra/plugins/git/plugins/fsmonitor/server";

const fsmonitorLog = defineLogSink({
  id: "worktree-fsmonitor",
  description:
    "Agent checkouts' git fsmonitor daemons: one line per reconcile — how many are on, which were started, stopped or had their index token renewed, and any failure.",
});

/**
 * Keeps git's fsmonitor daemon running for exactly the attempt checkouts the
 * user has not finished with (`attempts_v.retained`), on main.
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
 */
export const fsmonitorReconcileJob = defineJob({
  name: "worktree.fsmonitor-reconcile",
  description:
    "Keeps git's file-watching daemon running for the agent checkouts still in use (so git reads there cost what changed, not every file), and stops it for the ones whose conversations are closed.",
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
    const retention = await attemptRetention(
      attempts.map((e) => nameOf(e.path)),
    );
    const checkouts: FsmonitorCheckout[] = attempts.map((e) => {
      const retained = retention.get(nameOf(e.path));
      return {
        path: e.path,
        gitDir: e.gitDir,
        want: retained === undefined ? "unknown" : retained ? "on" : "off",
      };
    });
    const result = await reconcileCheckoutFsmonitors(checkouts, {
      orphanRoot: `${main.gitDir}/worktrees`,
      tier: "background",
      // A resume may have taken the checkout back since the read above.
      stillOff: async (c) =>
        (await attemptRetention([nameOf(c.path)])).get(nameOf(c.path)) ===
        false,
      signal,
    });
    fsmonitorLog.publish(describeFsmonitorReconcile(result));
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
    "Queues a pass over the agent checkouts' file-watching daemons at startup, so after a reboot their git reads are fast again within minutes.",
  scope: "host",
  run: async () => {
    await fsmonitorReconcileJob.enqueue({});
  },
});

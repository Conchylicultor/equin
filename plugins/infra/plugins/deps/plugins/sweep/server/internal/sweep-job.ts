import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import {
  appCheckoutOf,
  ensureMainWorktreeRoot,
  listWorktreePaths,
} from "@plugins/infra/plugins/worktree/server";
import { Log } from "@plugins/primitives/plugins/log-channels/server";
import { attemptRetention } from "@plugins/tasks/plugins/tasks-core/server";
import { sweepUnusedDeps } from "@plugins/infra/plugins/deps/deps";

const log = Log.channel("deps");

/**
 * Daily: reclaim installs nothing uses any more (an old lock, a dropped
 * worktree's trial). Main-only by virtue of its schedule; runs in process —
 * it only reads small files and removes directories asynchronously.
 *
 * The checkouts whose declarations keep an idle install are main's own and
 * the agent checkouts still in use: an attempt the user has not finished with
 * (`attempts_v.retained`, the rule `worktree.fsmonitor-reconcile` keeps
 * daemons by), or one whose row main does not hold (a worktree backend
 * minted it — unknown here, so it counts). A finished attempt's checkout runs
 * nothing until it is resumed; what it last used is protected by the idle
 * window like everything else, and on resume a missing install is installed
 * again on demand. Asking every checkout on disk (~450, most finished) for
 * every declaration was what made the sweep an hour of git.
 */
export const depsSweepJob = defineJob({
  name: "deps.sweep",
  description:
    "Removes installed optional dependencies that no checkout in use declares and that sat unused for two weeks.",
  hold: "minutes",
  inProcess:
    "A reclaim pass over the deps cache: small state-file reads, one identity derivation per (dependency with an idle install, checkout in use) and async directory removals; a restart aborts it and the next daily tick repeats it.",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "30 5 * * *" }, // daily at 05:30 UTC
  async run() {
    // Only the app's own checkouts (main and its worktrees) are read: git
    // lists any worktree of the repo, wherever its owner put it.
    const listed = await listWorktreePaths();
    const checkouts = (await Promise.all(listed.map(appCheckoutOf))).filter(
      (c) => c !== null,
    );
    const mainRoot = await ensureMainWorktreeRoot();
    // An agent checkout is `<worktrees dir>/<attempt id>`.
    const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
    const retention = await attemptRetention(
      checkouts.filter((c) => c !== mainRoot).map(nameOf),
    );
    const inUse = checkouts.filter(
      (c) => c === mainRoot || retention.get(nameOf(c)) !== false,
    );
    const report = await sweepUnusedDeps({
      checkouts: inUse,
      now: new Date(),
    });
    log.publish(
      `deps sweep over ${inUse.length} of ${checkouts.length} checkouts: removed ${report.removed.length} (${report.removed.join(", ") || "none"}), kept ${report.kept.length}` +
        (report.underivable.length > 0
          ? `; identity not derivable for ${report.underivable.length}: ${report.underivable.join("; ")}`
          : ""),
    );
  },
});

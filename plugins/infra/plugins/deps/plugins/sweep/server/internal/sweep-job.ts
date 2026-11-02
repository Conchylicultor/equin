import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import {
  appCheckoutOf,
  listWorktreePaths,
} from "@plugins/infra/plugins/worktree/server";
import { Log } from "@plugins/primitives/plugins/log-channels/server";
import { sweepUnusedDeps } from "@plugins/infra/plugins/deps/deps";

const log = Log.channel("deps");

/**
 * Daily: reclaim installs nothing uses any more (an old lock, a dropped
 * worktree's trial). Main-only by virtue of its schedule; runs in process —
 * it only reads small files and removes directories asynchronously.
 */
export const depsSweepJob = defineJob({
  name: "deps.sweep",
  description:
    "Removes installed optional dependencies that no checkout uses any more and that sat unused for two weeks.",
  hold: "minutes",
  inProcess:
    "A reclaim pass over the deps cache: small state-file reads, one identity derivation per (dep, checkout) and async directory removals; a restart aborts it and the next daily tick repeats it.",
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
    const report = await sweepUnusedDeps({
      checkouts,
      now: new Date(),
    });
    log.publish(
      `deps sweep: removed ${report.removed.length} (${report.removed.join(", ") || "none"}), kept ${report.kept.length}` +
        (report.underivable.length > 0
          ? `; identity not derivable for ${report.underivable.length}: ${report.underivable.join("; ")}`
          : ""),
    );
  },
});

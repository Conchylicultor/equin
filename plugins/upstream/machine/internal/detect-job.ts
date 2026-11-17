import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { Log } from "@plugins/primitives/plugins/log-channels/server";
import { checkUpstream } from "./release-status";

const log = Log.channel("upstream");

/**
 * Daily: has the repo this checkout was cloned from cut a release local `main`
 * does not hold? The answer is recorded (`upstream_release_check`) and pushed
 * through the `upstream.release-status` live value — that is all.
 *
 * **It files nothing and merges nothing.** An update is news, and the app shows
 * it where the user looks; the merge happens when they ask for it (or when the
 * Upstream merges automation, if they turned it on, files the task). Nothing
 * here writes to the working tree or moves a ref of ours; the only side effect
 * is the `git fetch` inside `fetchUpstreamStatus`.
 *
 * Scheduled, not watched: upstream has no change signal a clone can subscribe
 * to, and asking it is network work — so it is a daily `defineJob` rather than
 * anything in-process, and the live value re-derives the local half on every
 * move of `main` without asking upstream again.
 *
 * Main-only, by leaving `perWorktree` unset on the schedule. "Is there an
 * update?" is a question about the clone, not about one agent's branch.
 */
export const detectUpstreamUpdatesJob = defineJob({
  name: "upstream.detect-updates",
  description:
    "Checks whether the repository this checkout was cloned from has cut a release local main does not hold, and records the answer for the release status.",
  // One `git fetch` of a branch that may be far ahead, over the network.
  hold: "minutes",
  inProcess:
    "A read-only detection pass (one fetch, a few local ref reads, then one row upsert) that a restart can abort and the next daily tick simply repeats; it holds a slot for at most its five-minute fetch bound.",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "0 5 * * *" }, // daily at 05:00 UTC; perWorktree unset ⇒ main only
  async run() {
    const status = await checkUpstream();
    switch (status.kind) {
      case "no-upstream":
        log.publish(`no upstream to check (${status.reason})`);
        return;
      case "unreachable":
        // Log and record NOTHING: the job learned nothing about releases, so
        // the last answer stands. Tomorrow's tick simply asks again.
        log.publish(
          `could not reach ${status.remote} (${status.url}): ${status.detail}`,
        );
        return;
      case "no-release":
        log.publish(`${status.remote} has cut no release yet`);
        return;
      case "current":
        log.publish(`on ${status.remote}'s newest release ${status.release}`);
        return;
      case "behind":
        log.publish(
          `behind ${status.remote}'s newest release ${status.latest} (on ${status.current ?? "no release"})`,
        );
        return;
    }
  },
});

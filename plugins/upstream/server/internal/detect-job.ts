import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { Log } from "@plugins/primitives/plugins/log-channels/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { fetchUpstreamStatus } from "@plugins/upstream/core";
import { UPSTREAM_UPDATES_KIND, upstreamUpdatesTitle } from "./report-kind";

const log = Log.channel("upstream");

/**
 * Daily: has the repo this checkout was cloned from moved ahead of local
 * `main`? If so, record ONE report — the bell rings, Debug → Reports holds a
 * row, and that is all.
 *
 * **It files no task, and it merges nothing.** An update is news, not work
 * assigned: the user presses Investigate when they want it, and the task minted
 * then carries the merge instructions (`shared/merge-prompt.ts`) — or the
 * Upstream merges automation, when on, files that task itself. Nothing
 * here writes to the working tree or moves a ref of ours; the only side effect
 * is a `git fetch` inside `fetchUpstreamStatus`.
 *
 * Main-only, by leaving `perWorktree` unset on the schedule. "Is there an
 * update?" is a question about the clone, not about one agent's branch, and
 * every worktree asking it would fetch the same remote N times a day to file
 * the same single row.
 *
 * On the author's own checkout there is no upstream — the remote it publishes
 * to is its own — and the job returns having done nothing.
 */
export const detectUpstreamUpdatesJob = defineJob({
  name: "upstream.detect-updates",
  description:
    "Checks whether the repository this checkout was cloned from has new commits and records a report when it does.",
  // One `git fetch` of a branch that may be far ahead, over the network.
  hold: "minutes",
  inProcess:
    "A read-only detection pass (one fetch, one rev-list, then at most one report upsert) that a restart can abort and the next daily tick simply repeats; it holds a slot for at most its five-minute fetch bound.",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "0 5 * * *" }, // daily at 05:00 UTC; perWorktree unset ⇒ main only
  async run() {
    const status = await fetchUpstreamStatus(await getWorktreeRoot());
    if (status.kind === "no-upstream") {
      log.publish(`no upstream to check (${status.reason})`);
      return;
    }
    if (status.kind === "unreachable") {
      // Log and return, filing NOTHING. The job learned nothing about whether
      // updates exist, so it has nothing to report — and a weekly "we could not
      // check" row would be a bell the user learns to ignore, which costs more
      // than the missed check. Tomorrow's tick simply asks again.
      log.publish(
        `could not reach ${status.remote} (${status.url}): ${status.detail}`,
      );
      return;
    }
    if (status.kind === "current") {
      log.publish(`up to date with ${status.ref}`);
      return;
    }

    const data = {
      remote: status.remote,
      url: status.url,
      ref: status.ref,
      count: status.count,
      newest: status.newest.map((c) => ({ sha: c.sha, subject: c.subject })),
    };
    await recordReport({
      kind: UPSTREAM_UPDATES_KIND,
      source: "server-upstream-monitor",
      message: upstreamUpdatesTitle(data),
      data,
    });
    log.publish(
      `${status.count} commit(s) behind ${status.ref}; newest ${status.newest[0]?.sha ?? "(unknown)"}`,
    );
  },
});

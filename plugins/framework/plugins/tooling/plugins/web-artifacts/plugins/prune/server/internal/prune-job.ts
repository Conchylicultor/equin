import { z } from "zod";
import { pruneWebArtifactCaches } from "@plugins/framework/plugins/tooling/plugins/web-artifacts/core";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";

const pruneLog = defineLogSink({
  id: "web-artifacts-prune",
  description:
    "Web-artifact cache prune log: one line per hourly run — what it read, how long it held the store lock, what it removed.",
});

const s = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;

/**
 * Keeps the shared web caches bounded without any build paying for it. The
 * prune collects what every dist on the host links (memoized per dist, so
 * only the dists new since the last run have their links read) and stats every
 * unreferenced entry — O(the host's caches) — so it used to make every build's
 * `detect` stage O(machine), minutes under a file-metadata stall. A build is
 * safe without it: its lease pins what it composes.
 *
 * Hourly, main only (a schedule's default: the caches are host-global, and N
 * backends pruning would only queue on the store lock). In a supervised child,
 * so the synchronous scan never blocks a backend's event loop and no job slot
 * is held. `runAttempts: 1`: the next tick is the retry.
 */
export const webArtifactsPruneJob = defineSupervisedJob({
  name: "web-artifacts.prune",
  description:
    "Deletes old web build artifacts no served app links any more, keeping the shared build cache bounded.",
  input: z.object({}),
  channel: pruneLog,
  schedule: { cron: "17 * * * *" },
  runAttempts: 1,
  async run(_input, { log }) {
    const r = await pruneWebArtifactCaches();
    log(
      `survey ${s(r.surveyMs)} (${r.dists} dists, ${r.distsLinksRead} read off their links, ${r.distTargets} linked entries, ${r.surveyedEntries} unlinked entries stat'd); ` +
        `lock wait ${s(r.lockWaitMs)}; locked ${s(r.lockedMs)} (${r.distsReread} dists re-read, ${r.removed} removed)`,
    );
  },
});

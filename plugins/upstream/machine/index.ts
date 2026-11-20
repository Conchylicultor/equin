import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { RestartSkip } from "@plugins/build/plugins/restart-skip/plugins/hooks/server";
import {
  checkUpstreamEndpoint,
  cutReleaseEndpoint,
} from "@plugins/upstream/plugins/release/core";
import { detectUpstreamUpdatesJob } from "./internal/detect-job";
import { firstUpstreamCheckWarmup } from "./internal/first-check";
import { handleCheckUpstream } from "./internal/handle-check";
import { handleCutRelease } from "./internal/handle-cut";
import { publisherStatusServed } from "./internal/publisher-status";
import { upstreamMergeAutomation } from "./internal/merge-automation";
import { releaseStatusServed } from "./internal/release-status";

export default {
  description:
    "Upstream releases, desktop-only half: serves the upstream.release-status live value (the last check's answer — upstream's newest release tag — joined with where local main stands against it, re-derived from git whenever a tracked ref moves), the daily upstream.detect-updates job (main only; also enqueued once after boot while no check has ever recorded an answer, so a fresh install does not wait a day) that fetches upstream's main and release tags, records the answer and writes the update reminder notification when one is due (at most every two weeks whichever release it is about, or when the user's snooze ends; never while reminders are off, the release is skipped or an update task exists), POST /api/upstream/check, the same check on request, the upstream.publisher-status live value on the checkout that publishes (main of the canonical repo: its newest release, the commits on main since, and whether the commit main serves can be released — building, failed, already released — read from the served dist and main's build_runs), POST /api/upstream/release, which runs `./equin version cut` itself (one implementation, every refusal the CLI's), and the Upstream merges automation (upstream-merge; off by default, daily once on): when upstream has cut a release local main does not hold and no merge task is open, it files ONE auto-started task (Upstream category) whose agent runs `./equin upstream merge` (which merges the release tag), builds and checks the app, and lands it only as far as its Push setting allows (never, by default). Every check — job, endpoint, automation — records its answer the same way.",
  httpRoutes: {
    [checkUpstreamEndpoint.route]: handleCheckUpstream,
    [cutReleaseEndpoint.route]: handleCutRelease,
  },
  contributions: [
    ...releaseStatusServed.declare,
    ...publisherStatusServed.declare,
    // A deploy adopted without a restart moves the commit this backend
    // serves: whether it holds the release (`installed`) may have changed,
    // and so has the commit a release would tag.
    RestartSkip.Adopted({
      what: "whether the served build holds the newest upstream release, and the commit a release would tag",
      adopt: () => {
        releaseStatusServed.notify();
        publisherStatusServed.notify();
      },
    }),
  ],
  register: [
    detectUpstreamUpdatesJob,
    firstUpstreamCheckWarmup,
    upstreamMergeAutomation,
  ],
} satisfies MachinePluginDefinition;

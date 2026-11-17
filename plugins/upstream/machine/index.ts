import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { RestartSkip } from "@plugins/build/plugins/restart-skip/plugins/hooks/server";
import { checkUpstreamEndpoint } from "@plugins/upstream/plugins/release/core";
import { detectUpstreamUpdatesJob } from "./internal/detect-job";
import { handleCheckUpstream } from "./internal/handle-check";
import { upstreamMergeAutomation } from "./internal/merge-automation";
import { releaseStatusServed } from "./internal/release-status";

export default {
  description:
    "Upstream releases, desktop-only half: serves the upstream.release-status live value (the last check's answer — upstream's newest release tag — joined with where local main stands against it, re-derived from git whenever a tracked ref moves), the daily upstream.detect-updates job (main only) that fetches upstream's main and release tags and records the answer, POST /api/upstream/check, the same check on request, and the Upstream merges automation (upstream-merge; off by default, daily once on): when upstream has cut a release local main does not hold and no merge task is open, it files ONE auto-started task (Upstream category) whose agent runs `./equin upstream merge` (which merges the release tag), builds and checks the app, and lands it only as far as its Push setting allows (never, by default). Every check — job, endpoint, automation — records its answer the same way.",
  httpRoutes: {
    [checkUpstreamEndpoint.route]: handleCheckUpstream,
  },
  contributions: [
    ...releaseStatusServed.declare,
    // A deploy adopted without a restart moves the commit this backend
    // serves: whether it holds the release (`installed`) may have changed.
    RestartSkip.Adopted({
      what: "whether the served build holds the newest upstream release",
      adopt: () => releaseStatusServed.notify(),
    }),
  ],
  register: [detectUpstreamUpdatesJob, upstreamMergeAutomation],
} satisfies MachinePluginDefinition;

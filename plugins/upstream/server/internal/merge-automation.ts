import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { defineAutomation } from "@plugins/tasks/plugins/automations/server";
import {
  linkReportsToTask,
  uninvestigatedReports,
} from "@plugins/reports/plugins/engine/server";
import { fetchUpstreamStatus } from "@plugins/upstream/core";
import { upstreamMergeConfig, UPSTREAM_MERGE_ID } from "../../shared/config";
import {
  upstreamMergeTitle,
  upstreamMergeVariables,
} from "../../shared/merge-prompt";
import { UPSTREAM_UPDATES_KIND } from "./report-kind";

/** The task category every upstream-merge task is filed under. */
export const UPSTREAM_CATEGORY_ID = "upstream";

/**
 * Upstream merges: for someone who cloned this repo, on the configured
 * schedule (daily by default), ask upstream how far ahead it is and, when it
 * holds commits local `main` does not and no merge task is open, file ONE
 * auto-started task whose agent runs `./singularity upstream merge` in its own
 * worktree, builds, checks the app — and lands it only as far as the Push
 * setting allows (never, by default: the user lands a change to their own
 * trunk).
 *
 * The rolling `upstream-updates-available` report still records the news; a
 * filed task is linked to it, so its Investigate button does not mint a second
 * merge task beside this one.
 *
 * `no-upstream` (the canonical repo) and `unreachable` (offline) file nothing:
 * neither says there is anything to merge.
 */
export const upstreamMergeAutomation = defineAutomation({
  id: UPSTREAM_MERGE_ID,
  label: "Upstream merges",
  icon: symbol("call-merge"),
  description:
    "Checks the repository this checkout was cloned from for new commits and files one task that merges them with `./singularity upstream merge`.",
  categoryId: UPSTREAM_CATEGORY_ID,
  config: upstreamMergeConfig,
  triggers: { kinds: ["schedule"] },
  inProcess:
    "A detection pass (one fetch of upstream's main, one rev-list, then at most one task insert) that a restart can abort and the next scheduled tick simply repeats; the fetch is bounded by its own five-minute timeout.",
  promptVariables: [
    {
      name: "updates",
      description:
        "How many commits upstream is ahead, its URL and the newest of them",
    },
    {
      name: "ref",
      description: "The remote-tracking ref merged, e.g. origin/main",
    },
  ],
  detect: async () => {
    const status = await fetchUpstreamStatus(await getWorktreeRoot());
    if (status.kind !== "behind") return null;
    return {
      title: upstreamMergeTitle(status),
      variables: upstreamMergeVariables(status),
      sourceKeys: [],
      onFiled: async (taskId) => {
        const reports = await uninvestigatedReports({
          kinds: [UPSTREAM_UPDATES_KIND],
          minCount: 1,
          limit: 1,
        });
        await linkReportsToTask(
          reports.map((r) => r.id),
          taskId,
        );
      },
    };
  },
});

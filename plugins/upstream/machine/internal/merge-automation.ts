import { mandatePolicy } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";
import { reportRequired } from "@plugins/tasks/plugins/outcome-report/plugins/capability/core";
import {
  exitClean,
  flagRaise,
  pushPolicy,
} from "@plugins/conversations/plugins/conversation-view/plugins/push-and-exit/plugins/capabilities/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { defineAutomation } from "@plugins/tasks/plugins/automations/server";
import {
  UPSTREAM_CATEGORY_ID,
  upstreamMergeConfig,
  UPSTREAM_MERGE_ID,
} from "../../shared/config";
import { checkUpstream } from "./release-status";
import {
  upstreamMergeTitle,
  upstreamMergeVariables,
} from "../../shared/merge-prompt";

/**
 * Upstream merges: for someone who cloned this repo, on the configured
 * schedule (daily by default), ask upstream for its newest release and, when
 * local `main` does not hold it and no merge task is open, file ONE
 * auto-started task whose agent runs `./equin upstream merge` (which merges
 * the release tag) in its own worktree, builds, checks the app — and lands it
 * only as far as the Push setting allows (never, by default: the user lands a
 * change to their own trunk).
 *
 * `no-upstream` (the canonical repo), `no-release` (upstream has cut none) and
 * `unreachable` (offline) file nothing: none says there is a release to merge.
 * Upstream's `main` moving between releases is never a reason to file.
 */
export const upstreamMergeAutomation = defineAutomation({
  id: UPSTREAM_MERGE_ID,
  label: "Upstream merges",
  icon: symbol("call-merge"),
  description:
    "Checks the repository this checkout was cloned from for a new release and files one task that merges it with `./equin upstream merge`.",
  categoryId: UPSTREAM_CATEGORY_ID,
  // No re-run on settle: a dropped merge leaves upstream still ahead, and
  // detecting again at once would re-file it. The next scheduled run looks again.
  watch: null,
  config: upstreamMergeConfig,
  // Its agent may push as far as the Push setting allows and raise a flag for
  // the person. It finishes with its outcome report and stays open for review:
  // it calls exit_clean only when a person asks it to.
  mandate: (settings) =>
    mandatePolicy([
      pushPolicy.grant(settings.push),
      flagRaise.grant(true),
      exitClean.grant("on-request"),
      reportRequired.grant(true),
    ]),
  triggers: { kinds: ["schedule"] },
  inProcess:
    "A detection pass (one fetch of upstream's main and release tags, a few local ref reads, then at most one task insert) that a restart can abort and the next scheduled tick simply repeats; the fetch is bounded by its own five-minute timeout.",
  promptVariables: [
    {
      name: "updates",
      description:
        "The release upstream has cut, its URL and the release this checkout is on",
    },
    {
      name: "ref",
      description: "The release tag merged, e.g. v2026.11.14",
    },
  ],
  detect: async () => {
    // checkUpstream, not a bare fetch: the answer it acts on is recorded, so
    // the app's release status never disagrees with a task it just filed.
    const status = await checkUpstream();
    if (status.kind !== "behind") return null;
    return {
      title: upstreamMergeTitle(status),
      variables: upstreamMergeVariables(status),
      sourceKeys: [],
    };
  },
});

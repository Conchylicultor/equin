import { useLive } from "@plugins/network/plugins/live/web";
import type {
  SiteBannerAnswer,
  SiteBannerSpec,
  SiteProps,
} from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import {
  deployRunHistory,
  type Deployment,
  type DeployRunRecord,
} from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import {
  runningCommit,
  shortSha,
  type RunningCommit,
} from "@plugins/apps/plugins/deploy/plugins/remote-deploy/core";
import {
  foldResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { formatRelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { InvestigateRun } from "./investigate-failure-action";

const errorIcon = symbol("error");

/**
 * The site page's failure banner: the site's newest run (from the durable
 * ledger, so it survives a restart) failed. Says on which leg and when, the
 * CLI's own message verbatim, what the box still serves, and offers
 * Investigate — the same agent brief as the history row's action.
 */
export function useFailureBanner({ deployment }: SiteProps): SiteBannerAnswer {
  const newest = useLive(deployRunHistory, {
    where: { deploymentId: deployment.id },
    orderBy: [["startedAt", "desc"]],
    limit: 1,
  });
  const commit = useLive(runningCommit, { deploymentId: deployment.id });
  return foldResource(newest, {
    // Not known yet: hold the chain so no lower banner flashes first.
    loading: (): SiteBannerAnswer => "pending",
    error: (error) => ({
      tone: "destructive",
      icon: errorIcon,
      title: "Couldn't read this site's deploy history",
      body: error.message,
    }),
    ready: (rows) => failureSpec(rows[0], deployment, commit),
  });
}

function failureSpec(
  run: DeployRunRecord | undefined,
  deployment: Deployment,
  commit: ResourceResult<RunningCommit>,
): SiteBannerSpec | null {
  if (run?.status !== "failed") return null;
  const when = formatRelativeTime(run.finishedAt ?? run.startedAt);
  const name = deployment.hostnames[0] ?? deployment.compositionId;
  const serves =
    commit.status === "ready" && commit.data.kind === "known"
      ? ` ${name} still serves ${shortSha(commit.data.sha)}.`
      : "";
  return {
    tone: "destructive",
    icon: errorIcon,
    title: run.phaseFailed ? `Failed on ${run.phaseFailed}` : "Deploy failed",
    body: `${when}${run.message ? ` — ${run.message}` : ""}.${serves}`,
    actions: <InvestigateRun run={run} />,
  };
}

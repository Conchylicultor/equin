import type { ReactNode } from "react";
import { rowOrStale, useLive } from "@plugins/network/plugins/live/web";
import {
  deployRunHistory,
  deployRunIdKind,
} from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import type {
  SiteLiveExhibitProps,
  SiteLiveProps,
} from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/site-row/web";
import { InvestigateRun } from "./investigate-failure-action";

/**
 * Investigate, in the health report's site row: offered while the site's
 * latest run failed — the same subject, brief and copy as the site page's
 * failure banner, read off the run's ledger row.
 */
export function SiteInvestigateAction({ site }: SiteLiveProps): ReactNode {
  const failedId = site.run?.status === "failed" ? site.run.id : null;
  const record = rowOrStale(useLive(deployRunHistory, { id: failedId }));
  if (failedId === null || record === undefined) return null;
  return <InvestigateRun run={record} />;
}

/** Investigate in an exhibit state: briefed on the fixture's failed run. */
export function SiteInvestigateActionExhibit({
  site,
}: SiteLiveExhibitProps): ReactNode {
  const { run } = site;
  if (run?.status !== "failed") return null;
  return (
    <InvestigateRun
      run={{
        ...run,
        id: deployRunIdKind.parse(run.id),
        deploymentId: site.deploymentId,
        serverId: "exhibit-server",
        compositionId: site.compositionId,
        releaseRunId: null,
        commitSha: null,
        commitSubject: null,
        phaseFailed: run.phase,
        startedAt: new Date(run.startedAt),
        finishedAt: run.finishedAt === null ? null : new Date(run.finishedAt),
        exitCode: 1,
        approvalSections: [],
        // A ledger row as the history read hands it: no other plugin's columns.
        $columns: {},
      }}
    />
  );
}

import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { refHeadServed } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import { boxLinks } from "@plugins/apps/plugins/deploy/plugins/box-link/core";
import {
  _deployDeployments,
  _deployRuns,
  deployRunsServed,
  latestDeployRun,
} from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import { readRunningCommit } from "@plugins/apps/plugins/deploy/plugins/remote-deploy/server";
import { siteHealth, type SiteHealth } from "../../core";
import { currentLinks, linkOf } from "./store";

/**
 * `deploy.box-links`: the links this instance holds, from memory. The link
 * manager notifies it on every frame that changes a link (a beat included).
 */
export const boxLinksServed = serveValue(boxLinks, {
  source: "external",
  changes: "notified",
  readCost: "memory",
  loader: () => currentLinks(),
});

async function loadSiteHealth(): Promise<Record<string, SiteHealth>> {
  const rows = await db
    .select({
      id: _deployDeployments.id,
      compositionId: _deployDeployments.compositionId,
      hostnames: _deployDeployments.hostnames,
    })
    .from(_deployDeployments);
  const entries = await Promise.all(
    rows.map(async (r): Promise<[string, SiteHealth]> => {
      const link = linkOf(r.id);
      const run = latestDeployRun(r.id);
      return [
        r.id,
        {
          deploymentId: r.id,
          compositionId: r.compositionId,
          hostname: r.hostnames[0] ?? null,
          link:
            link === undefined
              ? { kind: "main-only" }
              : { kind: "linked", link },
          run:
            run === undefined
              ? null
              : {
                  id: run.id,
                  verb: run.verb,
                  phase: run.phase,
                  status: run.status,
                  startedAt: run.startedAt,
                  finishedAt: run.finishedAt,
                  message: run.message,
                },
          release: await readRunningCommit(r.id),
        },
      ];
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * `deploy.site-health`: every deployment's link, newest run and running
 * commit, folded here so the health report reads ONE value. Its changes:
 * a deployment or run row written (`reads`), the live run view moving
 * (`deployRunsServed`), `main` advancing (`refHeadServed`), and a link
 * changing STATE — the link manager's own `notify()`, never a beat.
 */
export const siteHealthServed = serveValue(siteHealth, {
  source: "external",
  changes: "notified",
  reads: {
    tables: [_deployDeployments, _deployRuns],
    reason:
      "every deployment row is an entry, and its running commit is its newest succeeded ship",
  },
  recomputeOn: [deployRunsServed, refHeadServed],
  loader: loadSiteHealth,
});

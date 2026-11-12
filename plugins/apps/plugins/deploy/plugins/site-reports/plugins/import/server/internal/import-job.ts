import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { endpointPath } from "@plugins/infra/plugins/endpoints/server";
import { Log } from "@plugins/primitives/plugins/log-channels/server";
import { recordReportIncident } from "@plugins/reports/plugins/engine/server";
import { _deployDeployments } from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import { hostOnlyQueryOverSsh } from "@plugins/apps/plugins/deploy/plugins/host-query/server";
import {
  siteReportsListEndpoint,
  SiteReportsPageSchema,
} from "@plugins/apps/plugins/deploy/plugins/site-reports/plugins/intake/core";
import {
  reduceSiteReport,
  WEBSITE_VISITOR_ERROR_KIND,
  websiteVisitorErrorSummary,
} from "../../core";
import type { ImportOutcome } from "../../core/internal/outcome";
import { planImport } from "./plan";
import { siteReportImports } from "./tables";

const log = Log.channel("site-reports-import");

/** Every bound of one pull, per run. */
export const IMPORT_LIMITS = {
  /** Deployments asked per run. */
  maxDeployments: 20,
  /** Rows asked of one box (the site's most recently seen). */
  pageRows: 100,
  /** One box's answer, in bytes: past it the answer is refused unread. */
  maxAnswerBytes: 1_000_000,
  /** Reports recorded per deployment per run; the rest wait for the next. */
  maxPerRun: 50,
} as const;

/**
 * Hourly, on main: pull each deployment's visitor error reports from its box
 * and record them in this computer's Reports.
 *
 * - **Pull, never push.** The computer SSHes out (the Deploy app's pinned host
 *   key and deploy key) and curls the box's host-only list; nothing on the
 *   internet can write to this machine. A schedule because the box has no
 *   change signal reaching here — a push from it is the inbound path this
 *   design forbids.
 * - **Structured data only.** Each row goes through `reduceSiteReport`: typed,
 *   clamped fields, the site's payload never copied.
 * - **Bounded.** `IMPORT_LIMITS`, one row per (deployment, site fingerprint),
 *   and each deployment's batch is ONE incident — one bell per run at most,
 *   behind the engine's fan-out ceiling and the kind's 24 h re-alert window.
 * - **No agent.** Recorded under the untrusted `website-visitor` source, which
 *   the engine's worklist (every automation's input) leaves out.
 *
 * A failed pull files nothing — it learned nothing about the site's errors —
 * and is logged and kept as the deployment's `last_outcome`. A site whose
 * release does not serve the intake answers 404 (`route-missing`).
 */
export const importSiteReportsJob = defineJob({
  name: "site-reports.import",
  description:
    "Pulls the errors your deployed sites' visitors hit from each site's server and records them in Reports, marked as website visitors.",
  hold: "minutes",
  inProcess:
    "A read-only pull (at most two SSH sessions at once, each bounded by its 20 s deadline) and a bounded batch of report upserts; a restart aborts it and the next hourly tick resumes from the stored watermark.",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "23 * * * *" }, // hourly; perWorktree unset ⇒ main only
  async run() {
    const deployments = await db
      .select({
        id: _deployDeployments.id,
        hostnames: _deployDeployments.hostnames,
      })
      .from(_deployDeployments)
      .orderBy(asc(_deployDeployments.id))
      .limit(IMPORT_LIMITS.maxDeployments);
    // One deployment's failure must not stop the others' imports; it still
    // fails the run, loudly, once every deployment had its turn.
    const failures: unknown[] = [];
    for (const deployment of deployments) {
      try {
        await importDeployment(deployment.id, deployment.hostnames);
      } catch (err) {
        log.publish(`${deployment.id}: import failed: ${String(err)}`);
        failures.push(err);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `site-reports.import: ${failures.length} deployments failed to import`,
      );
    }
  },
});

async function importDeployment(
  deploymentId: string,
  hostnames: readonly string[],
): Promise<void> {
  const [state] = await db
    .select()
    .from(siteReportImports)
    .where(eq(siteReportImports.deploymentId, deploymentId));
  const answer = await hostOnlyQueryOverSsh(
    deploymentId,
    endpointPath(
      siteReportsListEndpoint,
      {},
      { limit: IMPORT_LIMITS.pageRows },
    ),
    SiteReportsPageSchema,
    { maxAnswerBytes: IMPORT_LIMITS.maxAnswerBytes },
  );
  if (answer.kind === "not-found") return; // deleted mid-run; its row cascades
  if (answer.kind !== "answer") {
    const outcome = outcomeOf(answer.kind);
    log.publish(`${deploymentId}: ${outcome} (${answer.kind})`);
    await saveState(deploymentId, state?.watermark ?? null, outcome);
    return;
  }

  const plan = planImport(
    answer.value.reports,
    state?.watermark ?? null,
    IMPORT_LIMITS.maxPerRun,
  );
  if (plan.take.length > 0) {
    const site = { deploymentId, hostnames };
    await recordReportIncident(
      plan.take.map((record) => {
        const data = reduceSiteReport(record, site);
        return {
          kind: WEBSITE_VISITOR_ERROR_KIND,
          source: "website-visitor" as const,
          message: websiteVisitorErrorSummary(data),
          data,
          // The code the visitor ran: the site's own commit, so a fix landed
          // here is judged against the right code. Never this backend's pin.
          commit: data.commit,
          occurredAt: Date.parse(data.lastSeenAt),
        };
      }),
    );
  }
  log.publish(
    `${deploymentId}: imported ${plan.take.length} of ${answer.value.reports.length}`,
  );
  await saveState(deploymentId, plan.watermark, "imported");
}

function outcomeOf(
  kind:
    | "no-ssh-key"
    | "unverified"
    | "ssh-failed"
    | "request-failed"
    | "route-missing"
    | "unreadable-answer",
): ImportOutcome {
  switch (kind) {
    case "no-ssh-key":
    case "unverified":
      return "not-connected";
    case "ssh-failed":
    case "request-failed":
    case "route-missing":
    case "unreadable-answer":
      return kind;
  }
}

async function saveState(
  deploymentId: string,
  watermark: Date | null,
  outcome: ImportOutcome,
): Promise<void> {
  const now = new Date();
  await db
    .insert(siteReportImports)
    .values({ deploymentId, watermark, lastRunAt: now, lastOutcome: outcome })
    .onConflictDoUpdate({
      target: siteReportImports.deploymentId,
      set: { watermark, lastRunAt: now, lastOutcome: outcome },
    });
}

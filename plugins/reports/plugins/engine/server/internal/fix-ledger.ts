import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  max,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "@plugins/database/server";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import { containsCommit } from "@plugins/primitives/plugins/commit-list/server";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import {
  getServerCommit,
  serverPinCommit,
} from "@plugins/build/plugins/server-build-id/server";
import { restateByMetadata } from "@plugins/shell/plugins/notifications/server";
import { _reports } from "@plugins/reports/server";
import { fixStandingOf, type ReportId } from "@plugins/reports/core";
import { reportsProducer } from "./producer";
import { _reportFixes } from "./tables";
import { readFixClaims, type FixClaim } from "./fix-trailers";
import { fixNoticeOf } from "./fix-notice";
import { ringRowBell } from "./bell";
import { defineRefReaction } from "@plugins/infra/plugins/git/plugins/git-watcher/server";

// The fix ledger (`report_fixes`) and the one writer of a report's derived
// fix state. Every fact is stamped by the code that observes it:
//
// - LANDED — main's history names the report (`ingestFixClaims`: on every
//   advance of main and at boot, idempotent);
// - DEPLOYED — main's backend runs code containing the fix
//   (`stampDeployedFixes`: at boot, and when a deploy is adopted without a
//   restart — "the process that runs the fix records it");
// - REGRESSED — an occurrence from code containing it (`fix-regression.ts`).
//
// Main's only: these are facts of main's history and main's process. The
// writers take their executor (default: the app's `db`) so the DB-backed suite
// drives them against a throwaway Postgres — `writeReport`'s precedent.

// One derivation at a time per report: a regression and a deploy stamp racing
// on one row would otherwise each derive from what the other has not written.
const perReport = createKeyedMutex();

/**
 * Derive report `reportId`'s fix state from its newest ledger row and write
 * it — the ONE writer of `fix_state` / `fix_commit` / `fix_state_at`. On a
 * change, every notification about the report says so in place
 * (`restateByMetadata`), and a regression rings a NEW row on top.
 */
export async function deriveReportFixState(
  reportId: ReportId,
  conn: NodePgDatabase = db,
): Promise<void> {
  await perReport.run(reportId, async () => {
    const [latest] = await conn
      .select()
      .from(_reportFixes)
      .where(eq(_reportFixes.reportId, reportId))
      .orderBy(desc(_reportFixes.landedAt), desc(_reportFixes.commit))
      .limit(1);
    const standing = fixStandingOf(latest ?? null);
    const [before] = await conn
      .select({ fixState: _reports.fixState, fixCommit: _reports.fixCommit })
      .from(_reports)
      .where(eq(_reports.id, reportId));
    if (!before) {
      throw new Error(
        `report_fixes names report ${reportId}, which this database does not hold`,
      );
    }
    if (
      before.fixState === standing.fixState &&
      before.fixCommit === standing.fixCommit
    ) {
      return;
    }
    // A regression is a new problem: the task that investigated the fix that
    // did not hold is unlinked, so the report is back on the worklist
    // (`uninvestigated.ts`) and its Fix files a fresh investigation.
    const regressed = standing.fixState === "regressed";
    const [row] = await reportsProducer.mutate(
      conn,
      (q, t) =>
        q
          .update(t)
          .set(regressed ? { ...standing, taskId: null } : standing)
          .where(eq(t.id, reportId)),
      { latency: "background", returning: getTableColumns(_reports) },
    );
    if (!row) return;
    await restateByMetadata("reportId", reportId, fixNoticeOf(standing), conn);
    if (regressed) await ringRowBell(row, conn);
  });
}

/**
 * Record every fix claim on main since the newest one recorded (a day of
 * overlap: commit times are not landing order), then stamp the fixes this
 * backend already runs (a fix landing on a commit it adopted, or pushed before
 * the boot's ingest, is live already).
 */
export async function ingestFixClaims(): Promise<void> {
  if (!isMain()) return;
  const [{ newest } = { newest: null }] = await db
    .select({ newest: max(_reportFixes.landedAt) })
    .from(_reportFixes);
  const since =
    newest === null ? null : new Date(newest.getTime() - 24 * 3600 * 1000);
  const claims = await readFixClaims(REPO_ROOT, since);
  if ((await recordFixClaims(claims)) > 0) await stampDeployedFixes();
}

/**
 * Record `claims` (idempotent: a claim already recorded is skipped) and derive
 * each newly claimed report; answers how many were new. A claim naming a
 * report this database does not hold is a broken assumption — push validates
 * the id against main's reports — so it is filed as a server error, not
 * dropped in silence, and the rest still land.
 */
export async function recordFixClaims(
  claims: readonly FixClaim[],
  conn: NodePgDatabase = db,
): Promise<number> {
  if (claims.length === 0) return 0;
  const known = new Set(
    (
      await conn
        .select({ id: _reports.id })
        .from(_reports)
        .where(
          inArray(
            _reports.id,
            claims.map((c) => c.reportId),
          ),
        )
    ).map((r) => r.id),
  );
  for (const c of claims) {
    if (known.has(c.reportId)) continue;
    reportServerError({
      message: `[reports] commit ${c.commit.slice(0, 12)} on main names report ${c.reportId} (Fixes-report), which main's database does not hold`,
      errorType: "UnknownFixedReport",
    });
  }
  const landed = claims.filter((c) => known.has(c.reportId));
  if (landed.length === 0) return 0;
  const inserted = await conn
    .insert(_reportFixes)
    .values(landed)
    .onConflictDoNothing()
    .returning({ reportId: _reportFixes.reportId });
  for (const id of new Set(inserted.map((r) => r.reportId))) {
    await deriveReportFixState(id, conn);
  }
  return inserted.length;
}

/**
 * Stamp `deployed_at` on every fix the code main now serves contains — the
 * backend process (its pin) AND the bundle it serves (`.build-commit`): a fix
 * may be on either side. A carrier that cannot name its commit decides
 * nothing; the fix stays pending until one that can boots.
 */
export async function stampDeployedFixes(): Promise<void> {
  if (!isMain()) return;
  const server = serverPinCommit();
  const web = await getServerCommit();
  if (server === null || web === null) return;
  await stampFixesContainedIn({ server, web, repoRoot: REPO_ROOT });
}

/**
 * Stamp `deployed_at` on every pending fix both `server` and `web` contain,
 * placed in `repoRoot`, and derive each one's report.
 */
export async function stampFixesContainedIn(
  carriers: { server: string; web: string; repoRoot: string },
  conn: NodePgDatabase = db,
): Promise<void> {
  const { server, web, repoRoot } = carriers;
  const pending = await conn
    .select({ reportId: _reportFixes.reportId, commit: _reportFixes.commit })
    .from(_reportFixes)
    .where(isNull(_reportFixes.deployedAt));
  const now = new Date();
  for (const fix of pending) {
    const inServer = await containsCommit(server, fix.commit, repoRoot);
    const inWeb = await containsCommit(web, fix.commit, repoRoot);
    if (inServer !== true || inWeb !== true) continue;
    await conn
      .update(_reportFixes)
      .set({ deployedAt: now })
      .where(
        and(
          eq(_reportFixes.reportId, fix.reportId),
          eq(_reportFixes.commit, fix.commit),
          isNull(_reportFixes.deployedAt),
        ),
      );
    await deriveReportFixState(fix.reportId, conn);
  }
}

/**
 * Stamp the regression of report `reportId`'s newest fix, if it has none yet:
 * the first occurrence from code containing it wins.
 */
export async function stampRegression(
  reportId: ReportId,
  fixCommit: string,
  regressedCommit: string | null,
  at: Date,
  conn: NodePgDatabase = db,
): Promise<void> {
  const stamped = await conn
    .update(_reportFixes)
    .set({ regressedAt: at, regressedCommit })
    .where(
      and(
        eq(_reportFixes.reportId, reportId),
        eq(_reportFixes.commit, fixCommit),
        isNull(_reportFixes.regressedAt),
      ),
    )
    .returning({ reportId: _reportFixes.reportId });
  if (stamped.length > 0) await deriveReportFixState(reportId, conn);
}

// A commit naming a report reached main: record the fix (pending). In-process
// and cheap; the boot's ingest is the fallback for an advance the backend
// missed while it was down.
export const fixClaimsReaction = defineRefReaction({
  name: "reports.fix-claims",
  refName: "refs/heads/main",
  run: ingestFixClaims,
});

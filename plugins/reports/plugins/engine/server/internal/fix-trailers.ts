import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import {
  containsCommit,
  runGit,
} from "@plugins/primitives/plugins/commit-list/server";
import {
  FIXES_REPORT_TRAILER,
  REPORT_FIXED_BY_TRAILER,
  fixedByClaim,
  reportIdKind,
  type ReportId,
} from "@plugins/reports/core";

/**
 * One fix claim on main: `commit` fixes `reportId`, claimed at `landedAt`.
 * `claimedBy` is the commit carrying a `Report-fixed-by` claim (the fix is an
 * earlier commit than it); absent for a `Fixes-report` one, whose fix is the
 * claiming push itself.
 */
export interface FixClaim {
  reportId: ReportId;
  commit: string;
  landedAt: Date;
  claimedBy?: string;
}

// NUL-separated fields, each record ended by a NUL + the newline git adds.
// The trailer values are comma-separated (one per report).
const FIX_LOG_FORMAT =
  "%H%x00%cI%x00" +
  `%(trailers:key=${LEGACY_IDS.pushTrailer},valueonly,separator=%x2C)%x00` +
  `%(trailers:key=${FIXES_REPORT_TRAILER},valueonly,separator=%x2C)%x00` +
  `%(trailers:key=${REPORT_FIXED_BY_TRAILER},valueonly,separator=%x2C)%x00`;

function reportIdIn(value: string, sha: string, trailer: string): ReportId {
  if (!reportIdKind.is(value)) {
    throw new Error(
      `commit ${sha.slice(0, 12)} names "${value}" in its ${trailer} trailer, which is not a report id`,
    );
  }
  return value;
}

/**
 * The fix claims in `git log --format=FIX_LOG_FORMAT` output (newest first),
 * one per (report, fix):
 *
 * - `Fixes-report: <id>` — the push is the fix. `./equin push` stamps its
 *   trailers on EVERY commit of a push, so the push's newest commit — the
 *   first seen — stands for it (code containing it contains the whole push).
 *   A commit with no push trailer (a hand-made one) stands for itself.
 * - `Report-fixed-by: <id>@<sha>` — the named earlier commit is the fix; the
 *   claim lands when its push does (the first commit seen carrying it).
 *
 * A malformed value is thrown on: push validates both, so one on main is a
 * broken assumption.
 */
export function parseFixLog(raw: string): FixClaim[] {
  const claims: FixClaim[] = [];
  const seen = new Set<string>();
  const claim = (key: string, c: FixClaim) => {
    if (seen.has(key)) return;
    seen.add(key);
    claims.push(c);
  };
  for (const record of raw.split("\0\n")) {
    if (record.trim().length === 0) continue;
    const [sha, iso, push, fixes, fixedBy] = record
      .replace(/^\n/, "")
      .split("\0");
    if (!sha || !iso) continue;
    const landedAt = new Date(iso);
    for (const value of (fixes ?? "").split(",")) {
      if (value.trim() === "") continue;
      const reportId = reportIdIn(value.trim(), sha, FIXES_REPORT_TRAILER);
      claim(`${reportId}\0${push?.trim() || sha}`, {
        reportId,
        commit: sha,
        landedAt,
      });
    }
    for (const value of (fixedBy ?? "").split(",")) {
      if (value.trim() === "") continue;
      const parsed = fixedByClaim(value);
      if (parsed === null) {
        throw new Error(
          `commit ${sha.slice(0, 12)} carries "${value.trim()}" in its ${REPORT_FIXED_BY_TRAILER} trailer, which is not <report id>@<full sha>`,
        );
      }
      const reportId = reportIdIn(
        parsed.reportId,
        sha,
        REPORT_FIXED_BY_TRAILER,
      );
      claim(`${reportId}\0${parsed.commit}`, {
        reportId,
        commit: parsed.commit,
        landedAt,
        claimedBy: sha,
      });
    }
  }
  return claims;
}

/**
 * Main's fix claims since `since` (null: its whole history — only right for
 * an empty ledger). Only commits whose message carries a trailer are read
 * (`--grep`, either key), so the walk is cheap whatever its window. Throws on
 * any git failure: "no claims" must never stand in for "could not read". A
 * `Report-fixed-by` claim whose fix is not an ancestor of the commit claiming
 * it (push refuses one: the claim names a commit already on main) is filed as
 * a server error and skipped.
 */
export async function readFixClaims(
  repoRoot: string,
  since: Date | null,
): Promise<FixClaim[]> {
  const raw = await runGit(
    [
      "log",
      "--no-color",
      `--grep=^${FIXES_REPORT_TRAILER}:`,
      `--grep=^${REPORT_FIXED_BY_TRAILER}:`,
      ...(since ? [`--since=${since.toISOString()}`] : []),
      `--format=${FIX_LOG_FORMAT}`,
      "refs/heads/main",
    ],
    repoRoot,
  );
  const claims: FixClaim[] = [];
  for (const c of parseFixLog(raw)) {
    if (
      c.claimedBy !== undefined &&
      (await containsCommit(c.claimedBy, c.commit, repoRoot)) !== true
    ) {
      // Filed and skipped, not thrown: the ingest re-reads this window on
      // every advance of main, so one bad claim must not hold back the rest.
      reportServerError({
        message: `[reports] commit ${c.claimedBy.slice(0, 12)} on main claims ${c.commit.slice(0, 12)} fixed report ${c.reportId} (${REPORT_FIXED_BY_TRAILER}), but that commit is not one of its ancestors`,
        errorType: "UnplaceableFixClaim",
      });
      continue;
    }
    claims.push(c);
  }
  return claims;
}

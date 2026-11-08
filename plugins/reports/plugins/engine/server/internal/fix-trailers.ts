import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import { runGit } from "@plugins/primitives/plugins/commit-list/server";
import {
  FIXES_REPORT_TRAILER,
  reportIdKind,
  type ReportId,
} from "@plugins/reports/core";

/** One fix claim on main: commit `commit` (landed at `landedAt`) names `reportId`. */
export interface FixClaim {
  reportId: ReportId;
  commit: string;
  landedAt: Date;
}

// NUL-separated fields, each record ended by a NUL + the newline git adds.
// The trailer values are comma-separated (one `Fixes-report` per report).
const FIX_LOG_FORMAT =
  "%H%x00%cI%x00" +
  `%(trailers:key=${LEGACY_IDS.pushTrailer},valueonly,separator=%x2C)%x00` +
  `%(trailers:key=${FIXES_REPORT_TRAILER},valueonly,separator=%x2C)%x00`;

/**
 * The fix claims in `git log --format=FIX_LOG_FORMAT` output (newest first),
 * one per (report, push): `./equin push` stamps its trailers on EVERY commit
 * of a push, so the push's newest commit — the first seen — stands for it
 * (code containing it contains the whole push). A commit with no push trailer
 * (a hand-made one) stands for itself. A value that is not a report id is
 * thrown on: push validates it, so one on main is a broken assumption.
 */
export function parseFixLog(raw: string): FixClaim[] {
  const claims: FixClaim[] = [];
  const seen = new Set<string>();
  for (const record of raw.split("\0\n")) {
    if (record.trim().length === 0) continue;
    const [sha, iso, push, fixes] = record.replace(/^\n/, "").split("\0");
    if (!sha || !iso) continue;
    for (const value of (fixes ?? "").split(",")) {
      const reportId = value.trim();
      if (reportId === "") continue;
      if (!reportIdKind.is(reportId)) {
        throw new Error(
          `commit ${sha.slice(0, 12)} names "${reportId}" in its ${FIXES_REPORT_TRAILER} trailer, which is not a report id`,
        );
      }
      const key = `${reportId}\0${push?.trim() || sha}`;
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push({ reportId, commit: sha, landedAt: new Date(iso) });
    }
  }
  return claims;
}

/**
 * Main's fix claims since `since` (null: its whole history — only right for
 * an empty ledger). Only commits whose message carries the trailer are read
 * (`--grep`), so the walk is cheap whatever its window. Throws on any git
 * failure: "no claims" must never stand in for "could not read".
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
      ...(since ? [`--since=${since.toISOString()}`] : []),
      `--format=${FIX_LOG_FORMAT}`,
      "refs/heads/main",
    ],
    repoRoot,
  );
  return parseFixLog(raw);
}

import { z } from "zod";
import { openShortLivedClient } from "@plugins/database/plugins/admin/server";
import { queryRows } from "@plugins/database/plugins/sql-rows/core";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import {
  containsCommit,
  tryRunGit,
} from "@plugins/primitives/plugins/commit-list/server";
import {
  FIXES_REPORT_TRAILER,
  REPORT_FIXED_BY_TRAILER,
  reportIdKind,
} from "@plugins/reports/core";

/** What `--fixes-report` / `--report-fixed-by` resolved to: the trailers to stamp, or why not. */
export type FixedReports =
  { ok: true; trailers: string[] } | { ok: false; message: string };

/**
 * The `Fixes-report` trailer for a push naming `ids` (null when it names
 * none): ONE trailer, its values comma-separated — the push's `--exec` amend
 * replaces a key it finds (`trailer.ifexists=replace`), so a repeated key
 * would keep only the last.
 */
export function fixesReportTrailer(ids: readonly string[]): string | null {
  return ids.length === 0 ? null : `${FIXES_REPORT_TRAILER}=${ids.join(", ")}`;
}

/**
 * The `Report-fixed-by` trailer for `claims` (null when there are none): one
 * trailer, each value `<report id>@<full sha>` — the earlier commit on main
 * that fixed the report.
 */
export function reportFixedByTrailer(
  claims: readonly { reportId: string; commit: string }[],
): string | null {
  return claims.length === 0
    ? null
    : `${REPORT_FIXED_BY_TRAILER}=${claims.map((c) => `${c.reportId}@${c.commit}`).join(", ")}`;
}

/**
 * Check what a push says it fixes before anything is written:
 *
 * - `ids` (`--fixes-report <id>`) — this push fixes them;
 * - `fixedBy` (`--report-fixed-by <id>@<sha>`) — an EARLIER commit, already
 *   on main, fixed the report without naming it. The sha must resolve to a
 *   commit that is an ancestor of `refs/heads/main` (so the claim never names
 *   code main has not run, nor this push's own — that is `--fixes-report`),
 *   and is stamped in full.
 *
 * Every id must be one of MAIN's reports — the fix ledger records only main's.
 * Refuses a malformed id or sha, an unknown report, a report named by both
 * flags, a `--report-fixed-by` report that already has a fix (not `open`),
 * and either trailer typed into the message: the flags are their one writer.
 */
export async function resolveFixedReports(input: {
  ids: readonly string[];
  fixedBy: readonly string[];
  message: string | undefined;
  repoRoot: string;
}): Promise<FixedReports> {
  for (const trailer of [FIXES_REPORT_TRAILER, REPORT_FIXED_BY_TRAILER]) {
    if (
      input.message !== undefined &&
      new RegExp(`^${trailer}:`, "im").test(input.message)
    ) {
      return {
        ok: false,
        message: `Name a fixed report with --fixes-report <id> or --report-fixed-by <id>@<sha>, not a "${trailer}:" line in -m.`,
      };
    }
  }
  const ids = [...new Set(input.ids.map((id) => id.trim()))];
  const pairs: { reportId: string; rev: string }[] = [];
  for (const raw of new Set(input.fixedBy.map((v) => v.trim()))) {
    const at = raw.lastIndexOf("@");
    if (at <= 0 || at === raw.length - 1) {
      return {
        ok: false,
        message: `--report-fixed-by: "${raw}" is not <report id>@<commit>.`,
      };
    }
    pairs.push({ reportId: raw.slice(0, at), rev: raw.slice(at + 1) });
  }
  const all = [...ids, ...pairs.map((p) => p.reportId)];
  if (all.length === 0) return { ok: true, trailers: [] };
  const malformed = all.filter((id) => !reportIdKind.is(id));
  if (malformed.length > 0) {
    return {
      ok: false,
      message: `${malformed.map((id) => `"${id}"`).join(", ")} is not a report id (report-…).`,
    };
  }
  const twice = [...new Set(all)].filter(
    (id) => all.filter((x) => x === id).length > 1,
  );
  if (twice.length > 0) {
    return {
      ok: false,
      message: `${twice.join(", ")} is named more than once — a report has one fix per push (--fixes-report for this push, or --report-fixed-by for one earlier commit).`,
    };
  }

  const claims: { reportId: string; commit: string }[] = [];
  for (const p of pairs) {
    const resolved = await tryRunGit(
      ["rev-parse", "--verify", "--quiet", `${p.rev}^{commit}`],
      input.repoRoot,
    );
    const commit = resolved.ok ? resolved.stdout.trim() : "";
    if (commit === "") {
      return {
        ok: false,
        message: `--report-fixed-by ${p.reportId}@${p.rev}: no such commit.`,
      };
    }
    const onMain = await containsCommit(
      "refs/heads/main",
      commit,
      input.repoRoot,
    );
    if (onMain !== true) {
      return {
        ok: false,
        message: `--report-fixed-by ${p.reportId}@${p.rev}: ${commit.slice(0, 12)} is not on main — a fix this push lands is named with --fixes-report.`,
      };
    }
    claims.push({ reportId: p.reportId, commit });
  }

  const pool = await openShortLivedClient(MAIN_WORKTREE_NAME);
  let state: Map<string, string>;
  try {
    const rows = await queryRows(pool, {
      sql: "SELECT id, fix_state FROM reports WHERE id = ANY($1::text[])",
      params: [all],
      row: z.object({ id: z.string(), fix_state: z.string() }),
    });
    state = new Map(rows.map((r) => [r.id, r.fix_state]));
  } finally {
    await pool.end();
  }
  const unknown = all.filter((id) => !state.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `main has no report ${unknown.join(", ")} (Debug → Reports on main lists them).`,
    };
  }
  // A claim on an earlier commit is for a fix the ledger never heard of. One
  // for a report that has a fix already would outrank it (the ledger's newest
  // row is the latest CLAIM), standing an older commit in for the fix in force.
  const claimed = claims.filter((c) => state.get(c.reportId) !== "open");
  if (claimed.length > 0) {
    return {
      ok: false,
      message: `--report-fixed-by: ${claimed.map((c) => `${c.reportId} (${state.get(c.reportId)})`).join(", ")} already has a fix in the ledger — a new fix is named with --fixes-report on the push that lands it.`,
    };
  }
  return {
    ok: true,
    trailers: [fixesReportTrailer(ids), reportFixedByTrailer(claims)].filter(
      (t): t is string => t !== null,
    ),
  };
}

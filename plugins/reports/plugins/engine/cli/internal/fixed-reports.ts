import { z } from "zod";
import { openShortLivedClient } from "@plugins/database/plugins/admin/server";
import { queryRows } from "@plugins/database/plugins/sql-rows/core";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import { FIXES_REPORT_TRAILER, reportIdKind } from "@plugins/reports/core";

/** What `--fixes-report` resolved to: the trailer to stamp, or why not. */
export type FixedReports =
  { ok: true; trailer: string | null } | { ok: false; message: string };

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
 * Check that every id a push says it fixes is one of MAIN's reports — the
 * fix ledger records only main's — before anything is written. Refuses a
 * malformed id, an unknown one, and a `Fixes-report:` line typed into the
 * message: the flag is the trailer's one writer.
 */
export async function resolveFixedReports(input: {
  ids: readonly string[];
  message: string | undefined;
}): Promise<FixedReports> {
  if (
    input.message !== undefined &&
    new RegExp(`^${FIXES_REPORT_TRAILER}:`, "im").test(input.message)
  ) {
    return {
      ok: false,
      message: `Name a fixed report with --fixes-report <id>, not a "${FIXES_REPORT_TRAILER}:" line in -m.`,
    };
  }
  const ids = [...new Set(input.ids.map((id) => id.trim()))];
  if (ids.length === 0) return { ok: true, trailer: null };
  const malformed = ids.filter((id) => !reportIdKind.is(id));
  if (malformed.length > 0) {
    return {
      ok: false,
      message: `--fixes-report: ${malformed.map((id) => `"${id}"`).join(", ")} is not a report id (report-…).`,
    };
  }
  const pool = await openShortLivedClient(MAIN_WORKTREE_NAME);
  let known: Set<string>;
  try {
    const rows = await queryRows(pool, {
      sql: "SELECT id FROM reports WHERE id = ANY($1::text[])",
      params: [ids],
      row: z.object({ id: z.string() }),
    });
    known = new Set(rows.map((r) => r.id));
  } finally {
    await pool.end();
  }
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `--fixes-report: main has no report ${unknown.join(", ")} (Debug → Reports on main lists them).`,
    };
  }
  return { ok: true, trailer: fixesReportTrailer(ids) };
}

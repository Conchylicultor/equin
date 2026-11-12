import { asc, desc, getTableColumns, inArray, sql } from "drizzle-orm";
import {
  deriveStatus,
  STATUS_HISTORY_MAX,
  type StatusHistoryEntry,
} from "../../core";
import { chunked, type DbExec } from "./db-exec";
import {
  _testCheckoutDigests,
  _testFileResults,
  _testFileStatus,
} from "./tables";

// Rows per INSERT / IN list: well under Postgres' 65,535 bind parameters.
const CHUNK = 500;

type StatusRow = typeof _testFileStatus.$inferInsert;

// `excluded.<column>` for every column but the key: an upsert rewrites the
// whole derived row.
const UPSERT_SET = Object.fromEntries(
  Object.entries(getTableColumns(_testFileStatus))
    .filter(([key]) => key !== "path")
    .map(([key, col]) => [key, sql.raw(`excluded."${col.name}"`)]),
);

/**
 * Re-derive `test_file_status` for `paths` (or every checkout file): each
 * checkout file's status (`deriveStatus` over its recorded results against its
 * current digest), its last result and its history strip, upserted; a status
 * row whose file is no longer in the checkout is deleted. The ONLY writer of
 * the table, so it can never disagree with the results it is derived from
 * — called after every ingested record (its files) and every new set of
 * checkout digests (all).
 */
export async function recomputeFileStatus(
  exec: DbExec,
  paths: readonly string[] | "all",
): Promise<{ upserted: number; deleted: number }> {
  if (paths !== "all" && paths.length === 0) return { upserted: 0, deleted: 0 };
  const scope = paths === "all" ? null : [...new Set(paths)];

  const digestRows =
    scope === null
      ? await exec.select().from(_testCheckoutDigests)
      : (
          await Promise.all(
            chunked(scope, CHUNK).map((c) =>
              exec
                .select()
                .from(_testCheckoutDigests)
                .where(inArray(_testCheckoutDigests.path, c)),
            ),
          )
        ).flat();

  const resultCols = {
    path: _testFileResults.path,
    digest: _testFileResults.digest,
    outcome: _testFileResults.outcome,
    finishedAt: _testFileResults.finishedAt,
    origin: _testFileResults.origin,
    opId: _testFileResults.opId,
    slug: _testFileResults.slug,
    cases: _testFileResults.cases,
    failedCases: _testFileResults.failedCases,
    durationMs: _testFileResults.durationMs,
  };
  const order = [
    asc(_testFileResults.path),
    desc(_testFileResults.finishedAt),
    desc(_testFileResults.opId),
  ];
  const results =
    scope === null
      ? await exec
          .select(resultCols)
          .from(_testFileResults)
          .orderBy(...order)
      : (
          await Promise.all(
            chunked(
              digestRows.map((d) => d.path),
              CHUNK,
            ).map((c) =>
              exec
                .select(resultCols)
                .from(_testFileResults)
                .where(inArray(_testFileResults.path, c))
                .orderBy(...order),
            ),
          )
        ).flat();
  const byPath = new Map<string, typeof results>();
  for (const r of results) {
    let list = byPath.get(r.path);
    if (!list) byPath.set(r.path, (list = []));
    list.push(r);
  }

  const rows: StatusRow[] = digestRows.map((d) => {
    const list = byPath.get(d.path) ?? [];
    const last = list[0];
    let currentPassed = 0;
    let currentFailed = 0;
    for (const r of list) {
      if (r.digest !== d.digest) continue;
      if (r.outcome === "passed") currentPassed++;
      else currentFailed++;
    }
    const history: StatusHistoryEntry[] = list
      .slice(0, STATUS_HISTORY_MAX)
      .map((r) => ({
        outcome: r.outcome,
        current: r.digest === d.digest,
        origin: r.origin,
        at: r.finishedAt.toISOString(),
        opId: r.opId,
      }));
    return {
      path: d.path,
      pluginId: d.pluginId,
      runner: d.runner,
      digest: d.digest,
      status: deriveStatus(d.digest, list),
      lastOutcome: last?.outcome ?? null,
      lastRanAt: last?.finishedAt ?? null,
      lastOpId: last?.opId ?? null,
      lastOrigin: last?.origin ?? null,
      lastSlug: last?.slug ?? null,
      cases: last?.cases ?? null,
      failedCases: last?.failedCases ?? null,
      durationMs: last?.durationMs ?? null,
      currentPassed,
      currentFailed,
      history,
    };
  });
  for (const c of chunked(rows, CHUNK))
    await exec
      .insert(_testFileStatus)
      .values(c)
      .onConflictDoUpdate({ target: _testFileStatus.path, set: UPSERT_SET });

  const present = new Set(digestRows.map((d) => d.path));
  let deleted = 0;
  if (scope === null) {
    const gone = await exec
      .delete(_testFileStatus)
      .where(
        sql`${_testFileStatus.path} NOT IN (SELECT ${_testCheckoutDigests.path} FROM ${_testCheckoutDigests})`,
      )
      .returning({ path: _testFileStatus.path });
    deleted = gone.length;
  } else {
    const absent = scope.filter((p) => !present.has(p));
    for (const c of chunked(absent, CHUNK)) {
      const gone = await exec
        .delete(_testFileStatus)
        .where(inArray(_testFileStatus.path, c))
        .returning({ path: _testFileStatus.path });
      deleted += gone.length;
    }
  }
  return { upserted: rows.length, deleted };
}

import { inArray } from "drizzle-orm";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
import type { TestRunRecord } from "@plugins/framework/plugins/cli/plugins/test/plugins/record/core";
import type { Db } from "@plugins/database/server";
import { chunked } from "./db-exec";
import { recomputeFileStatus } from "./recompute";
import { _testCaseFailures, _testFileResults, _testRuns } from "./tables";

const CHUNK = 500;

/** Which of `opIds` are already ingested (their run row exists). */
export async function ingestedOpIds(
  db: Db,
  opIds: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const c of chunked(opIds, CHUNK)) {
    const rows = await db
      .select({ opId: _testRuns.opId })
      .from(_testRuns)
      .where(inArray(_testRuns.opId, c));
    for (const r of rows) out.add(r.opId);
  }
  return out;
}

/**
 * Ingest one harvest record in one transaction: the run, its per-file
 * results, its failing cases (each `ON CONFLICT DO NOTHING`: a record ingested
 * twice — two passes racing, a fork that already holds main's — changes
 * nothing), then the status of the files it ran. Answers whether it was new.
 */
export async function ingestRunRecord(
  db: Db,
  record: TestRunRecord,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const finishedAt = new Date(record.finishedAt);
    const inserted = await tx
      .insert(_testRuns)
      .values({
        opId: record.opId,
        slug: record.slug,
        origin: record.origin,
        repo: record.repo,
        headSha: record.head,
        treeHash: record.treeHash,
        startedAt: new Date(record.startedAt),
        finishedAt,
        digestVersion: record.digestVersion,
        runners: record.runners,
        fileCount: record.files.length,
        failedCount: record.files.filter((f) => f.outcome !== "passed").length,
      })
      .onConflictDoNothing()
      .returning({ opId: _testRuns.opId });
    if (inserted.length === 0) return false;
    for (const c of chunked(record.files, CHUNK))
      await tx
        .insert(_testFileResults)
        .values(
          c.map((f) => ({
            id: `${record.opId}:${f.path}`,
            opId: record.opId,
            path: f.path,
            runner: f.runner,
            digest: f.digest,
            outcome: f.outcome,
            cases: f.cases,
            failedCases: f.failedCases,
            durationMs: f.durationMs,
            finishedAt,
            origin: record.origin,
            slug: record.slug,
          })),
        )
        .onConflictDoNothing();
    for (const c of chunked(record.failures, CHUNK))
      await tx
        .insert(_testCaseFailures)
        .values(
          c.map((f) => ({
            // A case id is the file's describe path: long, so the key is its hash.
            id: sha256Hex(`${record.opId}\0${f.path}\0${f.caseId}`),
            opId: record.opId,
            path: f.path,
            caseId: f.caseId,
            message: f.message,
            detail: f.detail,
          })),
        )
        .onConflictDoNothing();
    await recomputeFileStatus(
      tx,
      record.files.map((f) => f.path),
    );
    return true;
  });
}

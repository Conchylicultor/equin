import { sql } from "drizzle-orm";
import type { DbExecutor } from "@plugins/database/server";
import type { FilePricing, FileScan, UsageTotals } from "./scan";
import {
  _conversationUsageFiles,
  conversationUsage,
} from "../../server/internal/tables";

/**
 * Write what one sync changed: the file rows it advanced or re-priced, and the
 * conversation's totals (`null` when they did not move) — in ONE statement.
 *
 * Never a transaction of round trips: between two statements the server sits
 * idle in transaction, holding the file rows' locks while the app thinks — the
 * window a lost connection left open for 5 h on 2026-11-03, queueing every
 * later sync behind it. A data-modifying CTE runs both upserts atomically in
 * one round trip, each firing its own triggers (derived `updatedAt`, the change
 * feed). Each arm writes a different table and neither reads the other's
 * result, so the one snapshot they share costs nothing.
 */
export async function writeUsage(
  exec: DbExecutor,
  conversationId: string,
  files: readonly (FileScan & FilePricing)[],
  totals: UsageTotals | null,
): Promise<void> {
  if (files.length === 0) {
    if (totals !== null)
      await conversationUsage.upsert(conversationId, totals, exec);
    return;
  }
  const filesUpsert = exec
    .insert(_conversationUsageFiles)
    .values(files.map((row) => ({ conversationId, ...row })))
    .onConflictDoUpdate({
      target: [
        _conversationUsageFiles.conversationId,
        _conversationUsageFiles.path,
      ],
      set: {
        kind: sql`excluded.kind`,
        offset: sql`excluded.offset`,
        buckets: sql`excluded.buckets`,
        tailHashes: sql`excluded.tail_hashes`,
        costUsd: sql`excluded.cost_usd`,
        unpricedModels: sql`excluded.unpriced_models`,
      },
    });
  if (totals === null) {
    await filesUpsert;
    return;
  }
  // `.getSQL()`: drizzle parenthesises an embedded builder, and a
  // parenthesised CTE body is a syntax error.
  const usage = conversationUsage.upsertQuery(conversationId, totals);
  await exec.execute(sql`WITH files AS (${filesUpsert.getSQL()}) ${usage}`);
}

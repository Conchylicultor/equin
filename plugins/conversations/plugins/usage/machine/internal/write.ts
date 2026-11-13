import { sql } from "drizzle-orm";
import { writeAtomically, type DbExecutor } from "@plugins/database/server";
import type { FilePricing, FileScan, UsageTotals } from "./scan";
import {
  _conversationUsageAccountDays,
  _conversationUsageFiles,
  conversationUsage,
} from "../../server/internal/tables";

/** Cost a sync priced on one UTC day, to add to the account that spent it. */
export interface AccountSpend {
  accountId: string;
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  costUsd: number;
}

/**
 * Write what one sync changed: the file rows it advanced or re-priced, the
 * conversation's totals (`null` when they did not move), and the cost it priced
 * per account and day (added to what each day already holds) — in ONE
 * statement.
 *
 * Never a transaction of round trips: between two statements the server sits
 * idle in transaction, holding the file rows' locks while the app thinks — the
 * window a lost connection left open for 5 h on 2026-11-03, queueing every
 * later sync behind it. A data-modifying CTE runs every upsert atomically in
 * one round trip (`writeAtomically`), each firing its own triggers (derived
 * `updatedAt`, the change feed). Each arm writes a different table and none
 * reads another's result, so the one snapshot they share costs nothing. Atomic matters for the spend: a
 * write that fails moves neither the file rows nor the spend, so the next pass
 * prices — and files — the same delta once.
 */
export async function writeUsage(
  exec: DbExecutor,
  conversationId: string,
  files: readonly (FileScan & FilePricing)[],
  totals: UsageTotals | null,
  spend: readonly AccountSpend[] = [],
): Promise<void> {
  await writeAtomically(exec, [
    files.length > 0
      ? exec
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
          })
      : null,
    spend.length > 0
      ? exec
          .insert(_conversationUsageAccountDays)
          .values([...spend])
          .onConflictDoUpdate({
            target: [
              _conversationUsageAccountDays.accountId,
              _conversationUsageAccountDays.date,
            ],
            set: {
              costUsd: sql`"conversation_usage_account_days"."cost_usd" + excluded.cost_usd`,
            },
          })
      : null,
    totals !== null
      ? conversationUsage.upsertQuery(conversationId, totals)
      : null,
  ]);
}

import { sql } from "drizzle-orm";
import { writeAtomically, type DbExecutor } from "@plugins/database/server";
import {
  spendLedgerUpsert,
  type SpendLedgerRow,
} from "@plugins/infra/plugins/claude-cli/plugins/spend-ledger/server";
import { conversationSpendSource } from "@plugins/infra/plugins/claude-cli/plugins/spend-ledger/core";
import type { FilePricing, FileScan, UsageTotals } from "./scan";
import {
  _conversationUsageFiles,
  conversationUsage,
} from "../../server/internal/tables";

/**
 * Cost a sync priced in one UTC hour, to add to the account that spent it —
 * filed under the conversation's own source, which `writeUsage` stamps.
 */
export type AccountSpend = Omit<SpendLedgerRow, "source">;

/**
 * Write what one sync changed: the file rows it advanced or re-priced, the
 * conversation's totals (`null` when they did not move), and the cost it priced
 * per account and hour, under the conversation's `conv:` source (added to what
 * the spend ledger already holds, `spendLedgerUpsert`) — in ONE statement.
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
    spendLedgerUpsert(
      exec,
      spend.map((row) => ({
        ...row,
        source: conversationSpendSource(conversationId),
      })),
    ),
    totals !== null
      ? conversationUsage.upsertQuery(conversationId, totals)
      : null,
  ]);
}

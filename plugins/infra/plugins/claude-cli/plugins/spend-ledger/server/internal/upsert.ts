import { sql } from "drizzle-orm";
import type { AtomicWrite, DbExecutor } from "@plugins/database/server";
import type { SpendSource } from "../../core";
import { _claudeSpendHours } from "./tables";

/** Cost to add to one account's hour, under what spent it. */
export interface SpendLedgerRow {
  accountId: string;
  /** The UTC hour (`spendHourOf`); minutes and seconds must be zero. */
  hour: Date;
  source: SpendSource;
  costUsd: number;
}

/**
 * The ledger write for `rows`: each added to what its (account, hour, source)
 * already holds. A builder, not a run — an arm of the caller's
 * `writeAtomically` group, or awaited in its transaction — so the spend lands
 * with the write that counted it. `null` (no write) when there is nothing to add.
 */
export function spendLedgerUpsert(
  exec: DbExecutor,
  rows: readonly SpendLedgerRow[],
): AtomicWrite {
  if (rows.length === 0) return null;
  for (const row of rows) {
    if (row.hour.getTime() % 3_600_000 !== 0)
      throw new Error(
        `spend ledger row for ${row.accountId}/${row.source} is not on an hour: ${row.hour.toISOString()}`,
      );
  }
  const t = _claudeSpendHours;
  return exec
    .insert(t)
    .values([...rows])
    .onConflictDoUpdate({
      target: [t.accountId, t.hour, t.source],
      set: {
        costUsd: sql`"claude_spend_hours"."cost_usd" + excluded.cost_usd`,
      },
    });
}

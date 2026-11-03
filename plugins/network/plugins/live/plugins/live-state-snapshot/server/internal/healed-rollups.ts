import { reconciledRollups } from "@plugins/database/plugins/derived-tables/server";

/**
 * The rollups this boot's committed schema layer healed — rows the reconcile
 * upserted or deleted (derived-tables' `reconciledRollups()`, which throws
 * before the layer commits: A20).
 */
export function healedRollups(): string[] {
  return reconciledRollups()
    .filter((r) => r.upserted + r.deleted > 0)
    .map((r) => r.table);
}

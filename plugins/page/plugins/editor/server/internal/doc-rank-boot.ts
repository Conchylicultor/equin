import { db } from "@plugins/database/server";
import { docOrderRows } from "./page-doc-order";
import { markDocOrderDirty } from "./doc-order-dirty";
import { planPartitionDocRanks, reconcileDocRanks } from "./doc-rank";
import {
  withPageForest,
  type ForestExecutor,
  type PageScope,
} from "./page-forest";

/** What the boot reconcile found. */
export type BootDocRankOutcome =
  /** Every group already satisfied I-DR. */
  | { kind: "clean" }
  /**
   * The first boot of the column, or of a newly placed block type: no live row
   * of each type written held a key yet, so its rows were minted from scratch.
   * Expected once per database (main and each fork) and type, and silent.
   */
  | { kind: "backfill"; written: number }
  /**
   * The column was already maintained, and still some group disagreed with
   * document order — a writer changed a placement without going through the
   * marking mutators (or an old backend wrote during a hot-swap). Repaired, and
   * the caller files a report: it is a bug to find, not a state to absorb.
   */
  | {
      kind: "drift";
      written: number;
      /** Rows that HAD a key which no longer fit, vs rows that had none. */
      rekeyed: number;
      unkeyed: number;
      partitions: PageScope[];
    };

/**
 * Bring every sidebar group to invariant I-DR at boot — the `onReadyBlocking`
 * barrier, after `database`'s migrations, so it completes before the gateway
 * hot-swaps traffic onto this backend.
 *
 * Plans against the GLOBAL `docOrderRows()` (about one row per page), then
 * writes through the ordinary path: one `withPageForest` over exactly the
 * groups that need a change, each marked dirty, so the re-mint happens under
 * those groups' locks and is re-planned against what is committed there — a
 * writer racing the boot cannot be overwritten by this read's stale plan.
 * Idempotent: a second run finds nothing to change.
 *
 * Backfill vs drift is decided from the state BEFORE the write, per block
 * type: no live row of a type holding a key means that type was never placed
 * (the first boot of this database, or of a type newly declaring
 * `pageTreePlace`); otherwise any change is drift.
 */
export async function reconcileDocRanksAtBoot(
  executor: ForestExecutor = db,
): Promise<BootDocRankOutcome> {
  const rows = await docOrderRows(executor);
  const planned = planPartitionDocRanks(rows);
  if (planned.length === 0) return { kind: "clean" };

  const partitions = [...new Set(planned.map((c) => c.pageId))];
  const { value: written } = await withPageForest(
    partitions,
    async (ctx) => {
      markDocOrderDirty(ctx.tx, partitions);
      return reconcileDocRanks(ctx.tx);
    },
    executor,
  );

  // A backfill is per TYPE: a type no row of which held a key was never
  // placed before (the column's first boot, or a type newly declaring
  // `pageTreePlace`), so minting its rows is expected. A key that moved, or an
  // unkeyed row of a type already maintained, is drift.
  const keyedTypes = new Set(
    rows.filter((r) => r.docRank !== null).map((r) => r.type),
  );
  const typeOf = new Map(rows.map((r) => [r.id, r.type]));
  // A row the plan never read (written under the lock) is no backfill.
  const drifted = written.filter((c) => {
    const type = typeOf.get(c.id);
    return c.from !== null || type === undefined || keyedTypes.has(type);
  });
  if (drifted.length === 0) {
    return { kind: "backfill", written: written.length };
  }
  return {
    kind: "drift",
    written: written.length,
    rekeyed: written.filter((c) => c.from !== null).length,
    unkeyed: written.filter((c) => c.from === null).length,
    partitions,
  };
}

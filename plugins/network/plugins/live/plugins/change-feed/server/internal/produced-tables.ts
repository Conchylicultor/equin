import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { TableLayoutRequirement } from "@plugins/framework/plugins/server-core/core";
import { readInstalledTriggers } from "./route-layout";

// Boot-time invariants of the produced tables — the tables whose change source
// is an in-process change producer (`./producer`), not a trigger. See
// research/2026-10-01-global-scoped-change-routing-p5-p8.md (P5, A2′ / A3p).
//
// A table has exactly ONE change source. Two would deliver each write twice (a
// producer emit and a NOTIFY), and a table both produced and opted out of the
// feed is a contradiction a reader of either declaration cannot see. A2′ has
// three halves: one producer per table (module eval, in `defineChangeProducer`),
// the declarations below (boot, before the rebuild), and the catalog (boot, after
// it: no `live_state_*` trigger survived on a produced table — the denylist
// drops one a previous boot installed).
//
// A3p: a producer emits ids only — no key layout, no `unchanged` set. A route on
// a produced table that maps through, filters or matches on a column the change
// would have to carry can never be served scoped, so every change would recompute
// its readers FULL forever. Refused at boot, like A3 refuses a trigger that does
// not carry what its routes read.

/** Why a produced table conflicts with another change-source declaration. */
export interface ProducedConflict {
  table: string;
  /** `excluded` — also `ExcludeFromChangeFeed`; `rollup` — a feed-exempt derived-table rollup. */
  with: "excluded" | "rollup";
}

/** A2′ (declarations): produced ∩ (excluded ∪ feed-exempt) = ∅. Pure. */
export function findProducedConflicts(
  produced: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
  feedExempt: ReadonlySet<string>,
): ProducedConflict[] {
  const out: ProducedConflict[] = [];
  for (const table of [...produced].sort()) {
    if (excluded.has(table)) out.push({ table, with: "excluded" });
    if (feedExempt.has(table)) out.push({ table, with: "rollup" });
  }
  return out;
}

/** A3p: the produced tables whose routes need a carried column. Pure. */
export function findCarriedProducedRoutes(
  requirements: readonly TableLayoutRequirement[],
  produced: ReadonlySet<string>,
): TableLayoutRequirement[] {
  return requirements.filter(
    (r) => produced.has(r.table) && r.carry.length > 0,
  );
}

/**
 * A2′ (declarations) and A3p, before the trigger rebuild: throw (block boot)
 * on a produced table that is also opted out or a rollup, or whose routes need
 * a carried column.
 */
export function assertProducedTablesDeclared(
  produced: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
  feedExempt: ReadonlySet<string>,
  requirements: readonly TableLayoutRequirement[],
): void {
  const conflicts = findProducedConflicts(produced, excluded, feedExempt);
  if (conflicts.length > 0) {
    throw new Error(
      `[change-feed] ${conflicts.length} produced table(s) also declared another change source (A2′) — a table has exactly one:\n` +
        conflicts
          .map((c) =>
            c.with === "excluded"
              ? `  - "${c.table}" has a change producer AND an ExcludeFromChangeFeed: drop the exclusion (the producer already keeps the feed off it)`
              : `  - "${c.table}" has a change producer AND is a derived-table rollup: a rollup is fed by its source's change, never produced`,
          )
          .join("\n"),
    );
  }
  const carried = findCarriedProducedRoutes(requirements, produced);
  if (carried.length > 0) {
    throw new Error(
      `[change-feed] ${carried.length} produced table(s) have routes that need a carried key column (A3p) — a change producer emits ids only, so these readers would recompute FULL on every change:\n` +
        carried
          .map(
            (r) =>
              `  - "${r.table}" routes need ${r.carry.map((c) => `"${c}"`).join(", ")}`,
          )
          .join("\n") +
        "\nFix: route the produced table by its own PK (an identity route), or keep the reader on a triggered table.",
    );
  }
}

/**
 * A2′ (catalog), after the trigger rebuild: throw (block boot) if any
 * `live_state_*` trigger is installed on a produced table — read back from
 * `pg_trigger`, never assumed from the denylist the rebuild was handed.
 */
export async function assertNoTriggerOnProduced(
  db: NodePgDatabase,
  produced: ReadonlySet<string>,
): Promise<void> {
  const installed = await readInstalledTriggers(db, [...produced].sort());
  if (installed.length > 0) {
    throw new Error(
      `[change-feed] ${installed.length} live_state trigger(s) remain on produced table(s) (A2′) — their writes would reach readers twice:\n` +
        installed
          .map((t) => `  - "${t.table}" (${t.trigger} → ${t.fn})`)
          .join("\n") +
        "\nThe rebuild drops a trigger on a denylisted table; one surviving it is a rebuild that did not run or a trigger installed out of band. Restart to rebuild the feed.",
    );
  }
}

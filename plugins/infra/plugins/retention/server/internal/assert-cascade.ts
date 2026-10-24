import { getTableName } from "drizzle-orm";
import {
  getTableConfig,
  type ForeignKey,
  type PgTable,
} from "drizzle-orm/pg-core";
import { declareGrowthBound } from "./growth-bounds";

// Verify — at MODULE EVAL of the consumer — that a table's unbounded growth is
// really reclaimed by an FK `onDelete: "cascade"` to a named owner, then record
// the bound. Reading the drizzle table object is synchronous and DB-free:
// `getTableConfig(table).foreignKeys[].onDelete` / `.reference().foreignTable`
// are the schema declaration itself, and `migrations-in-sync` already guarantees
// that declaration matches the committed migrations. So a false claim (or a later
// edit that drops the `onDelete: "cascade"`) is caught by boot, not a DB probe.
//
// "Module eval of the consumer" = boot's import phase, so a violation is
// BOOT-FATAL. `./equin build` probes backend health after restart and fails
// loudly ("Check server logs") when the new backend never takes over — so a bad
// cascade claim surfaces as a failed build, not a silently-dead app. This mirrors
// the precedent in change-feed's `assertRouteTablesCovered` (a throwing boot
// invariant that a static `./equin check` cannot express).

/**
 * The first FK on `table` with `onDelete: "cascade"` whose referenced table is
 * `owner`, or `null` if there is none.
 *
 * NOTE on the `null`: this is a legitimate "no such FK" probe result, consumed
 * immediately by `markCascadeBounded` (which throws on it) — the sanctioned probe
 * shape per the api-design skill, not an absorbed failure. Kept out of the barrel;
 * exported only so the test can exercise it directly.
 */
export function findCascadeFk(
  table: PgTable,
  owner: PgTable,
): ForeignKey | null {
  const ownerName = getTableName(owner);
  const fks = getTableConfig(table).foreignKeys;
  return (
    fks.find(
      (fk) =>
        fk.onDelete === "cascade" &&
        getTableName(fk.reference().foreignTable) === ownerName,
    ) ?? null
  );
}

/**
 * Assert that `table` is bounded by an FK `onDelete: "cascade"` to `owner`
 * (deleting an owner row reclaims the children), then record a `cascade` growth
 * bound. Throws at module eval — naming the table, the owner, and every FK it
 * actually found — if no such cascade exists.
 */
export function markCascadeBounded(table: PgTable, owner: PgTable): void {
  const tableName = getTableName(table);
  const ownerName = getTableName(owner);
  const fk = findCascadeFk(table, owner);
  if (!fk) {
    const found = describeForeignKeys(table);
    throw new Error(
      `[retention] markCascadeBounded("${tableName}", "${ownerName}"): no FK ` +
        `with onDelete: "cascade" referencing "${ownerName}" was found on ` +
        `"${tableName}". FKs found: ${found}. Fix: give "${tableName}" a column ` +
        `\`.references(() => ${ownerName}.<pk>, { onDelete: "cascade" })\`, or ` +
        `bound the table with defineRetention instead.`,
    );
  }
  declareGrowthBound(tableName, { kind: "cascade", owner: ownerName });
}

/** Human-readable list of every FK on `table` (name + onDelete + target). */
function describeForeignKeys(table: PgTable): string {
  const fks = getTableConfig(table).foreignKeys;
  if (fks.length === 0) return "(none)";
  return fks
    .map((fk) => {
      const target = getTableName(fk.reference().foreignTable);
      return `${fk.getName()} (onDelete: ${fk.onDelete ?? "no action"} → ${target})`;
    })
    .join(", ");
}

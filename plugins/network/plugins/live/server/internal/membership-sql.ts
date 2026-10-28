import { and, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { filterColumns } from "@plugins/network/plugins/live/plugins/filter/core";
import { filterSql } from "@plugins/network/plugins/live/plugins/filter/server";
import type { LiveMembership } from "@plugins/network/plugins/live/core";

/**
 * A collection's declared `membership` rendered as SQL — the filter
 * language's `filterSql` over the base table's columns — or `undefined` when
 * it declared none. Each column the filter names must bind to the base
 * column of the same name, never through `columns` (`overrides`): the
 * browser re-checks a row's own field value against the same filter, so the
 * SQL must test that very column. It is read as the raw base column, as a
 * hand-written base `where` is (so the compiler routes it as one).
 */
export function membershipSql(
  membership: LiveMembership | undefined,
  sourceColumns: Readonly<Record<string, PgColumn>>,
  overrides: Readonly<Record<string, unknown>>,
  fail: (message: string) => never,
): SQL | undefined {
  if (membership === undefined) return undefined;
  const targets: Record<string, SQL> = {};
  for (const name of filterColumns(membership.filter)) {
    if (overrides[name] !== undefined) {
      fail(
        `\`membership\` reads "${name}", which binds through \`columns\` — a membership column is the base table's own column of that name, the value the browser re-checks on the row.`,
      );
    }
    const col =
      sourceColumns[name] ??
      fail(
        `\`membership\` reads "${name}", which is no column of the served table.`,
      );
    targets[name] = sql`${col}`;
  }
  return filterSql(membership.filter, targets, membership.filterable);
}

/** `a AND b`, either absent. */
export function andWhere(
  a: SQL | undefined,
  b: SQL | undefined,
): SQL | undefined {
  return a === undefined ? b : b === undefined ? a : and(a, b);
}

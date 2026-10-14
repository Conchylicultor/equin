import { getTableName, type SQLWrapper } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import {
  BASE_RELATION,
  type ColumnRef,
  type ExprField,
  type ExtensionJoin,
  type LookupJoin,
} from "@plugins/infra/plugins/query-resource/core";
import { presenceExpr } from "@plugins/infra/plugins/query-resource/server";
import {
  exposedColumns,
  LIVE_COLUMNS_KEY,
  type LiveExposedColumns,
  type LiveExposes,
} from "@plugins/network/plugins/live/core";
import type { ExposingExtension } from "./serve-columns";

// Which served exposures (`LiveColumns.Expose`) a collection folds, and how it
// joins each: the collection's `exposes` names the entities its rows reach —
// `base` (its own table) or a declared LOOKUP join's alias → an entity — and
// every exposure whose parent is one of them folds in, joined LEFT under its
// slice: onto the base's id (`ext.join(slice)`), or onto the lookup's own `on`
// column (`ext.join(slice, { on })` — the column naming the looked-up row, so
// a write to the side row routes `reverse` through the same chain the lookup's
// probe reads). Shared by the window form and the `all` form, so the two
// cannot reach an entity two ways.

/** One exposure a collection folds: its column set and the join that reads it. */
export interface ExposureFold {
  readonly handle: LiveExposedColumns;
  readonly join: ExtensionJoin;
}

/**
 * Resolve a collection's `exposes` against its base table and declared joins,
 * and pick the served exposures it reaches. Every relation is checked whether
 * or not an exposure reaches it, so a declaration cannot drift from its bind:
 * `base` must be the entity's table, any other relation a lookup join over it.
 * Throws (`fail`) on a relation that resolves to no such join, and on a slice
 * or a field name that two folded sets — or a row field and a set — share.
 */
export function exposureFolds(
  exposes: LiveExposes | null,
  base: PgTable,
  joins: readonly { kind: string; alias: string }[],
  served: readonly ExposingExtension[],
  taken: { fields: readonly string[]; sets: readonly string[] },
  fail: (message: string) => never,
): ExposureFold[] {
  if (exposes === null) return [];
  const baseName = getTableName(base);
  const reach = new Map<string, LookupJoin | null>();
  for (const [relation, ref] of Object.entries(exposes)) {
    if (relation === BASE_RELATION) {
      if (baseName !== ref.name) {
        fail(
          `\`exposes.base\` names entity "${ref.name}", but the collection reads table "${baseName}" — \`base\` is the collection's own entity.`,
        );
      }
      reach.set(ref.name, null);
      continue;
    }
    const join = joins.find((j) => j.alias === relation);
    if (join === undefined) {
      return fail(
        `\`exposes\` names relation "${relation}", which is neither \`base\` nor a join its server half declares.`,
      );
    }
    if (join.kind !== "lookup") {
      return fail(
        `\`exposes\` reaches entity "${ref.name}" through "${relation}", a ${join.kind} join — an entity is reached through a lookup join (N:1 on its id).`,
      );
    }
    const lookup = join as LookupJoin;
    if (getTableName(lookup.table) !== ref.name) {
      fail(
        `\`exposes.${relation}\` names entity "${ref.name}", but join "${relation}" reads table "${getTableName(lookup.table)}".`,
      );
    }
    reach.set(ref.name, lookup);
  }

  const folds: ExposureFold[] = [];
  const fields = new Map<string, string>(
    taken.fields.map((f) => [f, "the collection's row"]),
  );
  const sets = new Set<string>(taken.sets);
  for (const ext of served) {
    const { exposure } = ext;
    // Typed non-null (`ExposingExtension`); checked against a cast past it.
    if ((exposure as unknown) === null) {
      fail(
        "a `LiveColumns.Expose` contribution's extension exposes no fields — declare `exposes` on its shape.",
      );
    }
    const via = reach.get(exposure.parent.name);
    if (via === undefined) continue;
    const { slice } = exposure;
    if (sets.has(slice) || slice === LIVE_COLUMNS_KEY) {
      fail(
        `two column sets are named "${slice}" — an exposure's slice names its \`$columns\` slot.`,
      );
    }
    sets.add(slice);
    // A list names an exposed field by its id (`as`, else its key).
    for (const { id } of Object.values(exposure.fields)) {
      const owner = fields.get(id);
      if (owner !== undefined) {
        fail(
          `exposed field "${id}" of "${slice}" collides with ${owner}'s — a list names a field by its bare id, so one collection reaches one field of a name.`,
        );
      }
      fields.set(id, `"${slice}"`);
    }
    let join: ExtensionJoin;
    if (via === null) {
      join = ext.join(slice);
    } else {
      join = ext.join(slice, { on: via.on });
      // The extension's parent IS the looked-up row: its key references the
      // lookup's own pk, so `on` (which names that pk's value) names it.
      if (join.parentKey !== via.pk) {
        fail(
          `"${slice}" extends "${getTableName(join.parentKey.table)}"."${join.parentKey.name}", but join "${via.alias}" looks up "${getTableName(via.table)}"."${via.pk.name}" — the extension's parent must be the looked-up row.`,
        );
      }
    }
    folds.push({ handle: exposedColumns(exposure), join });
  }
  return folds;
}

/**
 * What one exposed field of `fold` binds to, over its join's refs (`j[alias]`
 * — each a column ref that also renders as SQL): a column field, its join's
 * wire column of the same name; the PRESENCE field, the expression over the
 * join's key (`presenceExpr` — `IS NOT NULL`, or a `CASE` to its two
 * literals). Throws on a column field its join offers no wire column for.
 */
export function exposedBinding(
  fold: ExposureFold,
  field: string,
  own: Readonly<Record<string, unknown>> | undefined,
  fail: (message: string) => never,
): ColumnRef | ExprField {
  const { handle, join } = fold;
  const refs = Object.values(own ?? {}) as (ColumnRef & SQLWrapper)[];
  if (handle.exposure.fields[field]?.presence != null) {
    const key =
      refs.find((r) => r.col === join.key) ??
      fail(
        `the presence field "${handle.wireName(field)}" reads its join "${join.alias}"'s key, which the join does not offer.`,
      );
    return presenceExpr(join, field, key);
  }
  return (
    (own?.[field] as ColumnRef | undefined) ??
    fail(
      `exposed field "${handle.wireName(field)}" binds to no wire column of its join "${join.alias}".`,
    )
  );
}

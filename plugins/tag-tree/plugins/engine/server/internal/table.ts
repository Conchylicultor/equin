import { index } from "drizzle-orm/pg-core";
import type { FieldsRecord } from "@plugins/fields/core";
import type { EntityRef } from "@plugins/infra/plugins/entities/core";
import {
  defaultNow,
  defineEntity,
  type DefaultedKeys,
  type Entity,
  type EntityMetaBase,
} from "@plugins/infra/plugins/entities/server";
import type { AnyTagTreeEntityRef, ExtraKeyOf } from "../../core";

type FieldsOf<R extends AnyTagTreeEntityRef> = R["fields"];

/** Per-column DDL a tree adds to the base: a rename (`name`), a DB default, an FK. */
export type TagTreeColumnsMeta<R extends AnyTagTreeEntityRef> = NonNullable<
  EntityMetaBase<FieldsOf<R>>["columns"]
>;

/** The tree's own `defineTagTreeTable` meta: column DDL, extra indexes, and how each extra moves `updatedAt`. */
export type TagTreeTableMeta<
  R extends AnyTagTreeEntityRef,
  C extends TagTreeColumnsMeta<R>,
> = {
  columns?: C;
  /** Indexes and checks beyond the base `<table>_parent_rank_idx`. */
  indexes?: EntityMetaBase<FieldsOf<R>>["indexes"];
} & ([ExtraKeyOf<R>] extends [never]
  ? { touchedBy?: never }
  : {
      /** Whether a write to each extra counts as a change of the tag (moves its `updatedAt`). */
      touchedBy: Record<ExtraKeyOf<R>, boolean>;
    });

/** The table `defineTagTreeTable` builds: the entity's, DB-defaulted timestamps plus the tree's own defaults. */
export type TagTreeTable<
  R extends AnyTagTreeEntityRef,
  C extends TagTreeColumnsMeta<R> = Record<never, never>,
> = Entity<
  FieldsOf<R>,
  | "createdAt"
  | "updatedAt"
  | DefaultedKeys<FieldsOf<R>, { columns: C } & EntityMetaBase<FieldsOf<R>>>
>["table"];

/** Every base column moves `updatedAt` except the identity and the creation stamp. */
const BASE_TOUCHED_BY = {
  id: false,
  name: true,
  parentId: true,
  color: true,
  childColors: true,
  icon: true,
  rank: true,
  createdAt: false,
} as const;

/**
 * A tag tree's table, built from its entity ref — a load-order leaf: call it
 * from the plugin's `server/internal/tables.ts` and export `.table` with a
 * leading `_` for drizzle-kit's schema glob. Wraps `defineEntity`: primary key
 * `id`; `createdAt` / `updatedAt` default now; a derived `updatedAt` (every
 * base column moves it but `id` / `createdAt`; each extra says, `touchedBy` —
 * required when the tree has extras); an index `<table>_parent_rank_idx` on
 * `(parent_id, rank)`. `columns` / `indexes` pass through to `defineEntity`
 * (`columns.rank.name` renames the rank column).
 */
export function defineTagTreeTable<
  R extends AnyTagTreeEntityRef,
  const C extends TagTreeColumnsMeta<R> = Record<never, never>,
>(
  entity: R,
  ...[meta]: [ExtraKeyOf<R>] extends [never]
    ? [meta?: TagTreeTableMeta<R, C>]
    : [meta: TagTreeTableMeta<R, C>]
): { table: TagTreeTable<R, C> } {
  const extraTouched: Record<string, boolean> = meta?.touchedBy ?? {};
  const columns: Record<string, unknown> = { ...meta?.columns };
  const built = defineEntity(
    entity as EntityRef<string, FieldsRecord>,
    {
      primaryKey: "id",
      updatedAt: { touchedBy: { ...BASE_TOUCHED_BY, ...extraTouched } },
      columns: {
        ...columns,
        createdAt: { default: defaultNow() },
        updatedAt: { default: defaultNow() },
      },
      indexes: (t: Record<string, unknown>) => [
        index(`${entity.name}_parent_rank_idx`).on(
          t["parentId"] as never,
          t["rank"] as never,
        ),
        ...((meta?.indexes?.(t as never) ?? []) as never[]),
      ],
    } as never,
  ) as { table: unknown };
  return { table: built.table as TagTreeTable<R, C> };
}

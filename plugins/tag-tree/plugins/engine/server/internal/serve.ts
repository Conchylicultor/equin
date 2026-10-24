import { getTableColumns, getTableName, eq } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import type { z } from "zod";
import type { Db } from "@plugins/database/server";
import { fieldsToZodObject } from "@plugins/fields/core";
import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { EntityTable } from "@plugins/infra/plugins/entities/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import type {
  AnyTagTreeEntityRef,
  ExtraKeyOf,
  TagRow,
  TagTree,
} from "../../core";

/** The handle a write runs through: the transaction `db.transaction` hands its callback. */
export type TagTreeTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** What the engine writes through: `db`, or a throwaway test database. */
export type TagTreeDb = Pick<Db, "transaction">;

/**
 * A row that references tags of a tree (a prototype's one tag, a place's tag
 * list). It lives in the owning plugin; the tree only asks it to follow a
 * delete.
 */
export interface TagCarrier {
  /** Inside the delete's transaction: every carrier of `deletedId` gets `parentId` instead (nothing at the root). */
  replaceDeleted(
    tx: TagTreeTx,
    deletedId: string,
    parentId: string | null,
  ): Promise<void>;
}

/** A nullable single-tag column: `UPDATE t SET col = parentId WHERE col = deletedId`. */
export function singleTagCarrier(
  table: PgTable,
  column: AnyPgColumn,
): TagCarrier {
  const key = Object.entries(getTableColumns(table)).find(
    ([, c]) => c === column,
  )?.[0];
  if (key === undefined) {
    throw new Error(
      `singleTagCarrier: column ${column.name} is not a column of ${getTableName(table)}.`,
    );
  }
  return {
    async replaceDeleted(tx, deletedId, parentId) {
      await tx
        .update(table)
        .set({ [key]: parentId })
        .where(eq(column, deletedId));
    },
  };
}

/** The base columns the engine reads and writes by name. */
type TagTreeColumns = {
  readonly [K in "id" | "name" | "parentId" | "rank"]: AnyPgColumn;
};

/** A tree's table as the engine takes it: one `defineTagTreeTable` built. */
export type TagTreeTableHandle = EntityTable & TagTreeColumns;

/** Everything the engine needs to write one tree — internal to the engine. */
export interface TagTreeStore {
  readonly table: TagTreeTableHandle;
  readonly carriers: readonly TagCarrier[];
  /** The tree's full row (base + extras), as stored — what a read is parsed with. */
  readonly rowSchema: ZodParser<TagRow & Record<string, unknown>>;
  /** What a client's `extra` is parsed with (only `editableExtras`, strict). */
  readonly extraSchema: ZodParser<Record<string, unknown>>;
  readonly refuseDelete: (
    tag: TagRow & Record<string, unknown>,
  ) => string | null;
}

/** A tree the server writes: what `TagTrees.Tree` carries. */
export interface ServedTagTree {
  /** The tree's identity: its route id and entity. */
  readonly tree: Pick<TagTree, "id" | "entity">;
  /** @internal The engine's handle on the tree's table, carriers and rules. */
  readonly store: TagTreeStore;
}

type RowOf<R extends AnyTagTreeEntityRef> = z.infer<
  ReturnType<typeof fieldsToZodObject<R["fields"]>>
>;

/**
 * Serve a declared tree: the engine's endpoints write it once it is
 * contributed (`TagTrees.Tree(serveTagTree(tree, …))`). `table` must be the
 * table `defineTagTreeTable(tree.entity)` built (its name is checked).
 */
export function serveTagTree<R extends AnyTagTreeEntityRef, Row extends TagRow>(
  tree: TagTree<Row> & { readonly entity: R },
  opts: {
    table: TagTreeTableHandle;
    carriers: readonly TagCarrier[];
    /** Extra fields a client may set through create/update `extra`; others → 400. Default none. */
    editableExtras?: readonly ExtraKeyOf<R>[];
    /** A reason to refuse deleting this tag (→ 400), or null. */
    refuseDelete?: (tag: RowOf<R>) => string | null;
  },
): ServedTagTree {
  const tableName = getTableName(opts.table);
  if (tableName !== tree.entity.name) {
    throw new Error(
      `serveTagTree("${tree.id}"): table ${tableName} is not the tree's entity ${tree.entity.name}.`,
    );
  }
  const rowSchema = fieldsToZodObject(tree.entity.fields);
  const editable = Object.fromEntries(
    (opts.editableExtras ?? []).map((k) => [k, true as const]),
  );
  const refuse = opts.refuseDelete;
  return Object.freeze({
    tree: { id: tree.id, entity: tree.entity },
    store: Object.freeze({
      table: opts.table,
      carriers: opts.carriers,
      rowSchema: rowSchema as unknown as TagTreeStore["rowSchema"],
      extraSchema: rowSchema.pick(editable).partial().strict() as ZodParser<
        Record<string, unknown>
      >,
      refuseDelete: refuse
        ? (tag: TagRow & Record<string, unknown>) => refuse(tag as RowOf<R>)
        : () => null,
    }),
  });
}

/** The tag-tree registry: every tree the engine's endpoints write. */
export const TagTrees = {
  Tree: defineServerContribution<ServedTagTree>("tag-tree.tree", {
    docLabel: (s) => s.tree.id,
  }),
};

/**
 * The served tree a request names. Unknown → 404; two contributions of one id
 * is a wiring bug — it throws (a 500), loud.
 */
export function resolveServedTree(
  treeId: string,
  served: readonly ServedTagTree[],
): ServedTagTree {
  const matches = served.filter((s) => s.tree.id === treeId);
  if (matches.length > 1) {
    throw new Error(
      `tag-tree: ${matches.length} trees are registered as "${treeId}" — a tree id must be unique.`,
    );
  }
  const [match] = matches;
  if (match === undefined) {
    throw new HttpError(404, `Unknown tag tree: ${treeId}`);
  }
  return match;
}

import { eq, sql } from "drizzle-orm";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { rankAdjacentTo } from "@plugins/primitives/plugins/rank/server";
import {
  resolveTagPath,
  wouldCycle,
  type CreateTagBody,
  type CreateTagPathBody,
  type CreateTagPathResult,
  type MoveTagBody,
  type TagRow,
  type UpdateTagBody,
} from "../../core";
import type { ServedTagTree, TagTreeDb, TagTreeTx } from "./serve";

// The tree writes. Each runs in ONE transaction that first takes
// `SHARE ROW EXCLUSIVE` on the tree's table: rank minting and path creation
// must see the complete sibling set, and two racing writers must not both
// mint the "last" rank or both create one path (precedent: places'
// `seedPlaceTagsWarmup`). Every refusal is an `HttpError` (404 unknown, 400
// refused); the rows reach clients through the tree's live collection.

type Row = TagRow & Record<string, unknown>;

/** Run `write` under the tree's table lock, with the tree's rows loaded. */
async function withTree<T>(
  served: ServedTagTree,
  database: TagTreeDb,
  write: (tx: TagTreeTx, rows: Row[]) => Promise<T>,
): Promise<T> {
  const { table, rowSchema } = served.store;
  return database.transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
    const raw = await tx.select().from(table);
    return write(
      tx,
      raw.map((r) => rowSchema.parse(r)),
    );
  });
}

function requireRow(rows: readonly Row[], id: string): Row {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new HttpError(404, `Unknown tag: ${id}`);
  return row;
}

function requireParent(rows: readonly Row[], parentId: string | null): void {
  if (parentId !== null && !rows.some((r) => r.id === parentId)) {
    throw new HttpError(404, `Unknown parent tag: ${parentId}`);
  }
}

/** Refuse a name a sibling under `parentId` already has (case-insensitive), `selfId` aside. */
function assertFreeName(
  rows: readonly Row[],
  parentId: string | null,
  name: string,
  selfId: string | null,
): void {
  const lower = name.toLowerCase();
  const clash = rows.find(
    (r) =>
      r.parentId === parentId &&
      r.id !== selfId &&
      r.name.toLowerCase() === lower,
  );
  if (clash) {
    throw new HttpError(400, `A sibling tag is already named "${clash.name}"`);
  }
}

/** The rank appending a new row under `parentId`. */
function appendRank(rows: readonly Row[], parentId: string | null): Rank {
  return rankAdjacentTo(rows, parentId, null, "after", new Set());
}

function parseExtra(
  served: ServedTagTree,
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (extra === undefined) return {};
  const parsed = served.store.extraSchema.safeParse(extra);
  if (!parsed.success) {
    throw new HttpError(
      400,
      `Not an editable field of the ${served.tree.id} tree: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** Create a tag, last among its siblings. */
export async function createTagIn(
  served: ServedTagTree,
  database: TagTreeDb,
  body: CreateTagBody,
): Promise<{ id: string }> {
  const extra = parseExtra(served, body.extra);
  return withTree(served, database, async (tx, rows) => {
    const parentId = body.parentId ?? null;
    requireParent(rows, parentId);
    assertFreeName(rows, parentId, body.name, null);
    const id = served.tree.entity.idKind.mint();
    await tx.insert(served.store.table).values({
      ...extra,
      id,
      name: body.name,
      parentId,
      color: body.color ?? null,
      icon: body.icon ?? null,
      rank: appendRank(rows, parentId).toJSON(),
    } as never);
    return { id };
  });
}

/** Make sure a path exists, creating each missing segment under the previous; answers the leaf. */
export async function createTagPathIn(
  served: ServedTagTree,
  database: TagTreeDb,
  body: CreateTagPathBody,
): Promise<CreateTagPathResult> {
  return withTree(served, database, async (tx, rows) => {
    const resolved = resolveTagPath(body.segments, rows);
    const created: string[] = [];
    let parentId: string | null = null;
    for (const segment of resolved) {
      if (segment.tagId !== null) {
        parentId = segment.tagId;
        continue;
      }
      const id = served.tree.entity.idKind.mint();
      // Every later segment is new too, under this one: no sibling to rank
      // against but the existing ones of the first created segment's parent.
      await tx.insert(served.store.table).values({
        id,
        name: segment.name,
        parentId,
        rank: appendRank(rows, parentId).toJSON(),
      } as never);
      created.push(id);
      parentId = id;
    }
    if (parentId === null) throw new Error("createTagPath: no segment");
    return { id: parentId, created };
  });
}

/** Edit a tag in place (never its position — that is `moveTagIn`). */
export async function updateTagIn(
  served: ServedTagTree,
  database: TagTreeDb,
  id: string,
  body: UpdateTagBody,
): Promise<void> {
  const extra = parseExtra(served, body.extra);
  await withTree(served, database, async (tx, rows) => {
    const tag = requireRow(rows, id);
    if (body.name !== undefined) {
      assertFreeName(rows, tag.parentId, body.name, tag.id);
    }
    const set = {
      ...extra,
      name: body.name,
      color: body.color,
      childColors: body.childColors,
      icon: body.icon,
    };
    const defined = Object.fromEntries(
      Object.entries(set).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(defined).length === 0) return;
    await tx
      .update(served.store.table)
      .set(defined as never)
      .where(eq(served.store.table.id, tag.id));
  });
}

/** Move a tag to `dest` (positional intent; the rank is minted here over the complete sibling set). */
export async function moveTagIn(
  served: ServedTagTree,
  database: TagTreeDb,
  id: string,
  dest: MoveTagBody,
): Promise<void> {
  await withTree(served, database, async (tx, rows) => {
    const tag = requireRow(rows, id);
    requireParent(rows, dest.parentId);
    if (wouldCycle(tag.id, dest.parentId, rows)) {
      throw new HttpError(400, "A tag cannot move under itself");
    }
    if (dest.targetId !== null) {
      const target = rows.find((r) => r.id === dest.targetId);
      if (!target || target.parentId !== dest.parentId) {
        throw new HttpError(
          400,
          `Drop target ${dest.targetId} is not a child of ${dest.parentId ?? "the root"}`,
        );
      }
    }
    if (dest.parentId !== tag.parentId) {
      assertFreeName(rows, dest.parentId, tag.name, tag.id);
    }
    const rank = rankAdjacentTo(
      rows,
      dest.parentId,
      dest.targetId,
      dest.zone,
      new Set([tag.id]),
    );
    await tx
      .update(served.store.table)
      .set({ parentId: dest.parentId, rank: rank.toJSON() } as never)
      .where(eq(served.store.table.id, tag.id));
  });
}

/**
 * Delete a tag: its children move up to its parent AT ITS POSITION (in their
 * order, between its neighbours), every carrier of it gets its parent instead,
 * then the row goes — one transaction.
 */
export async function deleteTagIn(
  served: ServedTagTree,
  database: TagTreeDb,
  id: string,
): Promise<void> {
  await withTree(served, database, async (tx, rows) => {
    const tag = requireRow(rows, id);
    const refusal = served.store.refuseDelete(tag);
    if (refusal !== null) throw new HttpError(400, refusal);

    const byRank = (a: Row, b: Row) =>
      a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0;
    const siblings = rows
      .filter((r) => r.parentId === tag.parentId && r.id !== tag.id)
      .sort(byRank);
    const prev = siblings.filter((r) => r.rank < tag.rank).at(-1);
    const next = siblings.find((r) => r.rank > tag.rank);
    const children = rows.filter((r) => r.parentId === tag.id).sort(byRank);
    if (children.length > 0) {
      // Clashing names among the lifted children and their new siblings are
      // allowed to stand: refusing would make a tag undeletable.
      const ranks = Rank.nBetween(
        prev ? Rank.from(prev.rank) : null,
        next ? Rank.from(next.rank) : null,
        children.length,
      );
      for (const [i, child] of children.entries()) {
        await tx
          .update(served.store.table)
          .set({ parentId: tag.parentId, rank: ranks[i]!.toJSON() } as never)
          .where(eq(served.store.table.id, child.id));
      }
    }
    for (const carrier of served.store.carriers) {
      await carrier.replaceDeleted(tx, tag.id, tag.parentId);
    }
    await tx
      .delete(served.store.table)
      .where(eq(served.store.table.id, tag.id));
  });
}

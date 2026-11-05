import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db, type DbExecutor } from "@plugins/database/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import {
  liveBlocks,
  PAGE_BLOCK_TYPE,
} from "@plugins/page/plugins/editor/server";
import {
  defaultTagColor,
  normalizeTagName,
  PAGE_TAG_VOCABULARY_MAX,
  pageTagIdKind,
  tagKey,
  type TagColor,
} from "../../core";
import {
  resolveTagRequests,
  type ResolvedTag,
  type TagRequest,
  type TagResolution,
  type VocabularyTag,
} from "./resolve";
import { _pageTags, pageBlocksTags } from "./tables";

/** A tag as a page carries it: its id, stored name and color. */
export interface PageTag {
  id: string;
  name: string;
  color: TagColor;
}

/** The whole vocabulary, oldest first. */
async function loadVocabulary(executor: DbExecutor): Promise<VocabularyTag[]> {
  return executor
    .select({ id: _pageTags.id, name: _pageTags.name, color: _pageTags.color })
    .from(_pageTags)
    .orderBy(asc(_pageTags.createdAt), asc(_pageTags.id));
}

/**
 * The vocabulary's names, oldest first — what an agent is shown to pick from
 * (`edit_page`'s live description). `[]` when no tag exists yet.
 */
export async function loadTagVocabularyNames(
  executor: DbExecutor = db,
): Promise<string[]> {
  return (await loadVocabulary(executor)).map((t) => t.name);
}

/**
 * The tags `pageId` carries, in the order the page shows them — `[]` for a page
 * with no tags. What the `<page-meta>` header states.
 */
export async function loadPageTags(
  pageId: string,
  executor: DbExecutor = db,
): Promise<PageTag[]> {
  const row = await pageBlocksTags.get(pageId, executor);
  if (row === undefined || row.tagIds.length === 0) return [];
  const tags = await executor
    .select({ id: _pageTags.id, name: _pageTags.name, color: _pageTags.color })
    .from(_pageTags)
    .where(
      inArray(
        _pageTags.id,
        row.tagIds.map((id) => pageTagIdKind.key(id)),
      ),
    );
  const byId = new Map<string, PageTag>(tags.map((t) => [t.id, t]));
  return row.tagIds.flatMap((id) => {
    const tag = byId.get(id);
    return tag === undefined ? [] : [tag];
  });
}

/**
 * Resolve a requested tag list against the vocabulary
 * (`resolveTagRequests`'s rules: case- and whitespace-insensitive matching,
 * duplicates collapsed, unknown names refused unless marked `create`).
 * Reads only — nothing is created until {@link writeResolvedPageTags}.
 */
export async function resolveTagNames(
  requests: readonly TagRequest[],
  executor: DbExecutor = db,
): Promise<TagResolution> {
  return resolveTagRequests(requests, await loadVocabulary(executor));
}

/** 404 unless `pageId` is a live page row. */
async function assertLivePage(
  pageId: string,
  executor: DbExecutor,
): Promise<void> {
  const rows = await executor
    .select({ id: liveBlocks.id })
    .from(liveBlocks)
    .where(
      and(eq(liveBlocks.id, pageId), eq(liveBlocks.type, PAGE_BLOCK_TYPE)),
    );
  if (rows.length === 0) {
    throw new HttpError(404, `page-tags: ${pageId} is not a live page`);
  }
}

/** The one write of a page's tag list, inside a caller's transaction. */
async function writePageTagIds(
  tx: DbExecutor,
  pageId: string,
  tagIds: readonly string[],
): Promise<void> {
  await assertLivePage(pageId, tx);
  const ids = [...new Set(tagIds)];
  if (ids.length === 0) {
    await pageBlocksTags.delete(pageId, tx);
    return;
  }
  const known = await tx
    .select({ id: _pageTags.id })
    .from(_pageTags)
    .where(
      inArray(
        _pageTags.id,
        ids.map((id) => pageTagIdKind.key(id)),
      ),
    );
  const knownIds = new Set<string>(known.map((t) => t.id));
  const unknown = ids.filter((id) => !knownIds.has(id));
  if (unknown.length > 0) {
    throw new HttpError(
      400,
      `page-tags: no tag has the id ${unknown.map((id) => JSON.stringify(id)).join(", ")}`,
    );
  }
  await pageBlocksTags.upsert(pageId, { tagIds: ids }, tx);
}

/**
 * Replace `pageId`'s tags with `tagIds`, in that order (duplicates collapse;
 * `[]` clears them and deletes the row). 404 for a page that is not live, 400
 * naming any id the vocabulary does not hold — nothing written either way.
 */
export async function setPageTags(
  pageId: string,
  tagIds: readonly string[],
  executor: DbExecutor = db,
): Promise<void> {
  await executor.transaction(async (tx) => {
    await writePageTagIds(tx, pageId, tagIds);
  });
}

/**
 * Write a resolved tag list onto `pageId`: create its `new` tags (a name some
 * other writer created in the meantime resolves to that tag), then set the
 * page's list — one transaction. Returns the stored names, in order, and the
 * names this call actually created.
 */
export async function writeResolvedPageTags(
  pageId: string,
  tags: readonly ResolvedTag[],
  executor: DbExecutor = db,
): Promise<{ names: string[]; created: string[] }> {
  return executor.transaction(async (tx) => {
    const fresh = tags.filter((t) => t.kind === "new");
    const created: string[] = [];
    if (fresh.length > 0) {
      await assertVocabularyRoom(tx, fresh.length);
      const inserted = await tx
        .insert(_pageTags)
        .values(
          fresh.map((t) => ({
            id: pageTagIdKind.mint(),
            name: t.name,
            nameKey: tagKey(t.name),
            color: t.color,
          })),
        )
        .onConflictDoNothing({ target: _pageTags.nameKey })
        .returning({ name: _pageTags.name });
      created.push(...inserted.map((r) => r.name));
    }
    const keys = tags.map((t) => tagKey(t.name));
    const stored = await tx
      .select({
        id: _pageTags.id,
        name: _pageTags.name,
        nameKey: _pageTags.nameKey,
      })
      .from(_pageTags)
      .where(inArray(_pageTags.nameKey, keys));
    const byKey = new Map(stored.map((t) => [t.nameKey, t]));
    const ordered = keys.map((key) => {
      const tag = byKey.get(key);
      if (tag === undefined) {
        throw new Error(
          `page-tags: tag "${key}" vanished while it was written`,
        );
      }
      return tag;
    });
    await writePageTagIds(
      tx,
      pageId,
      ordered.map((t) => t.id),
    );
    return { names: ordered.map((t) => t.name), created };
  });
}

/**
 * Refuse a write adding `adding` tags past {@link PAGE_TAG_VOCABULARY_MAX}:
 * the vocabulary is read whole under that cap, so a tag past it would make
 * it unreadable — refused here, where the user is told, rather than at the
 * next load. A count, not a lock: two creates racing at the cap may pass it
 * together; the `all` set's `max` (schema and loader) is the hard bound, and
 * fails loudly past it.
 */
async function assertVocabularyRoom(
  executor: DbExecutor,
  adding: number,
): Promise<void> {
  const [row] = await executor
    .select({ n: sql`count(*)::int`.mapWith(Number) })
    .from(_pageTags);
  if (row === undefined) throw new Error("page-tags: count(*) returned no row");
  const held = row.n;
  if (held + adding > PAGE_TAG_VOCABULARY_MAX) {
    throw new HttpError(
      400,
      `The tag vocabulary holds at most ${PAGE_TAG_VOCABULARY_MAX} tags (it has ${held}) — delete some before adding more`,
    );
  }
}

/** Add a tag to the vocabulary; 409 when its name (by key) is already one. */
export async function createPageTag(
  name: string,
  color?: TagColor,
): Promise<{ id: string }> {
  const stored = normalizeTagName(name);
  await assertVocabularyRoom(db, 1);
  const inserted = await db
    .insert(_pageTags)
    .values({
      id: pageTagIdKind.mint(),
      name: stored,
      nameKey: tagKey(stored),
      color: color ?? defaultTagColor(stored),
    })
    .onConflictDoNothing({ target: _pageTags.nameKey })
    .returning({ id: _pageTags.id });
  const row = inserted[0];
  if (row === undefined) {
    throw new HttpError(
      409,
      `page-tags: a tag named "${stored}" already exists`,
    );
  }
  return { id: row.id };
}

/** Rename and/or recolor a tag; 404 when it does not exist, 409 on a taken name. */
export async function updatePageTag(
  tagId: string,
  patch: { name?: string; color?: TagColor },
): Promise<void> {
  await db.transaction(async (tx) => {
    const key = pageTagIdKind.key(tagId);
    const changes: { name?: string; nameKey?: string; color?: TagColor } = {};
    if (patch.color !== undefined) changes.color = patch.color;
    if (patch.name !== undefined) {
      const name = normalizeTagName(patch.name);
      const nameKey = tagKey(name);
      const taken = await tx
        .select({ id: _pageTags.id })
        .from(_pageTags)
        .where(and(eq(_pageTags.nameKey, nameKey), ne(_pageTags.id, key)));
      if (taken.length > 0) {
        throw new HttpError(
          409,
          `page-tags: a tag named "${name}" already exists`,
        );
      }
      changes.name = name;
      changes.nameKey = nameKey;
    }
    const updated = await tx
      .update(_pageTags)
      .set(changes)
      .where(eq(_pageTags.id, key))
      .returning({ id: _pageTags.id });
    if (updated.length === 0) {
      throw new HttpError(404, `page-tags: no tag has the id "${tagId}"`);
    }
  });
}

/**
 * Remove a tag from the vocabulary and from every page carrying it, in one
 * transaction — a page left with no tags loses its row. 404 when it does not
 * exist.
 */
export async function deletePageTag(tagId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const key = pageTagIdKind.key(tagId);
    const t = pageBlocksTags.table;
    const holds = sql`${t.tagIds} @> ${JSON.stringify([tagId])}::jsonb`;
    await tx
      .update(t)
      .set({ tagIds: sql`${t.tagIds} - ${tagId}::text` })
      .where(holds);
    await tx.delete(t).where(sql`${t.tagIds} = '[]'::jsonb`);
    const deleted = await tx
      .delete(_pageTags)
      .where(eq(_pageTags.id, key))
      .returning({ id: _pageTags.id });
    if (deleted.length === 0) {
      throw new HttpError(404, `page-tags: no tag has the id "${tagId}"`);
    }
  });
}

import { eq, inArray } from "drizzle-orm";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import type { BlockOp } from "../../core";
import { newBlockId } from "../../core";
import { PAGE_BLOCK_TYPE } from "../../core";
import type { IdentifiedBlock } from "../../core";
import { _blocks } from "./tables";
import { collectBlockSubtrees } from "./collect-subtree";
import {
  pageScopesOf,
  type PageForestCtx,
  type PageScope,
} from "./page-forest";
import type { BlockReadExecutor } from "./page-id";
import {
  insertBlocks,
  type NewBlockRow,
  type PageClaim,
} from "./forest-writer";
import { parseBlockData } from "./parse-block-data";
import { BlockLifecycle, type CopiedBlock } from "./document-hooks";

/**
 * The server half of pasting a sub-page (`PageSource` in
 * `core/serialized-block.ts`). A copied page node carries no content — only
 * where its content lives — so a paste or a duplicate resolves it here, inside
 * the op's own locked transaction:
 *
 *  - a node whose id IS its source page is a CLAIM: the page itself moves
 *    ({@link readPageClaims} → `writeForestTarget`'s claimed placement);
 *  - any other page node is a COPY: {@link copyPageContent} clones the source's
 *    whole content under the new id.
 *
 * Reads raw `_blocks` because both halves must see trashed rows: a cut page is
 * in the trash when its paste claims it, and a copy of a page that was deleted
 * after the copy still clones what the page held.
 */

/** A page node of a paste/duplicate forest that names its source. */
interface SourcedPageNode {
  id: string;
  sourcePageId: string;
}

function sourcedPageNodes(op: BlockOp): SourcedPageNode[] {
  const forests =
    op.kind === "paste" || op.kind === "splice"
      ? [op.forest]
      : op.kind === "duplicate"
        ? op.placements.map((p) => p.forest)
        : [];
  const walk = (nodes: readonly IdentifiedBlock[]): SourcedPageNode[] =>
    nodes.flatMap((n) => [
      ...(n.type === PAGE_BLOCK_TYPE && n.pageSource
        ? [{ id: n.id, sourcePageId: n.pageSource.pageId }]
        : []),
      ...walk(n.children),
    ]);
  return forests.flatMap(walk);
}

/** The ids an op claims: its page nodes whose id is their own source. */
export function claimedPageIds(op: BlockOp): string[] {
  return sourcedPageNodes(op)
    .filter((n) => n.id === n.sourcePageId)
    .map((n) => n.id);
}

/**
 * The page nodes an op copies, as `(source, copy)` pairs. Only the TOP page
 * node of each copy is here: its nested sub-pages are part of its content, and
 * {@link copyPageContent} reaches them itself.
 */
export function copiedPages(
  op: BlockOp,
): { sourcePageId: string; copyPageId: string }[] {
  return sourcedPageNodes(op)
    .filter((n) => n.id !== n.sourcePageId)
    .map((n) => ({ sourcePageId: n.sourcePageId, copyPageId: n.id }));
}

/**
 * The extra forests a claim writes, beyond the destination page: the page's old
 * scope (the row leaves it) and every partition inside it (a trashed claim
 * un-flags its content). Read unlocked — it only names locks; everything
 * authoritative is re-read under them ({@link readPageClaims}).
 */
export async function claimLockScopes(
  executor: BlockReadExecutor,
  claimIds: readonly string[],
): Promise<PageScope[]> {
  if (claimIds.length === 0) return [];
  const subtree = await collectBlockSubtrees([...claimIds], executor);
  return pageScopesOf(executor, subtree);
}

/**
 * Resolve an op's claims under the lock. A claimed id with no row at all (the
 * page was purged since the cut) is not a claim: the paste simply creates a page
 * under that id, which nothing else can hold.
 *
 * Refused loudly:
 *  - a claimed row that is not a page — only a page node's id may equal its
 *    source, so this is a malformed request;
 *  - a claim live on the destination page itself, or a claim of the destination
 *    or of any page above it — moving a page into its own content would detach
 *    the whole chain from every root.
 */
export async function readPageClaims(
  ctx: PageForestCtx,
  op: BlockOp,
  destPageId: string,
): Promise<Map<string, PageClaim>> {
  const ids = claimedPageIds(op);
  const claims = new Map<string, PageClaim>();
  if (ids.length === 0) return claims;

  const rows = await ctx.tx
    .select({
      id: _blocks.id,
      type: _blocks.type,
      pageId: _blocks.pageId,
      deletedAt: _blocks.deletedAt,
      trashEntryId: _blocks.trashEntryId,
    })
    .from(_blocks)
    .where(inArray(_blocks.id, ids));

  const ancestors = await pageChainOf(ctx, destPageId);
  for (const row of rows) {
    if (row.type !== PAGE_BLOCK_TYPE) {
      throw new HttpError(
        400,
        `Block ${row.id} is a "${row.type}" row; only a page can be pasted by its own id`,
      );
    }
    if (ancestors.has(row.id)) {
      throw new HttpError(
        409,
        `Cannot paste page ${row.id} inside page ${destPageId}: it would be moved into its own content`,
      );
    }
    if (row.deletedAt === null && row.pageId === destPageId) {
      throw new HttpError(
        409,
        `Page ${row.id} is already on page ${destPageId}; a paste cannot move it within the same forest`,
      );
    }
    claims.set(row.id, {
      pageId: row.pageId,
      trashEntryId: row.trashEntryId,
    });
  }
  return claims;
}

/** `pageId` and every page above it, up to the workspace root. */
async function pageChainOf(
  ctx: PageForestCtx,
  pageId: string,
): Promise<Set<string>> {
  const chain = new Set<string>();
  let current: string | null = pageId;
  while (current !== null && !chain.has(current)) {
    chain.add(current);
    const [row]: { pageId: string | null }[] = await ctx.tx
      .select({ pageId: _blocks.pageId })
      .from(_blocks)
      .where(eq(_blocks.id, current))
      .limit(1);
    current = row?.pageId ?? null;
  }
  return chain;
}

/**
 * Clone each source page's content under its copy, recursively: every row of
 * the source partition gets a fresh id, a nested sub-page gets a fresh page id
 * and its own content cloned under it, and each row keeps its type, data, rank
 * and expanded flag. Ranks are safe to keep — each copied sibling space is new
 * and holds exactly the source's siblings.
 *
 * WHICH rows are the page's content follows the source page row's own state: a
 * live page copies its live rows; a trashed page (copied, then deleted, then
 * pasted) copies the rows its delete trashed with it — the page as it was. A row
 * deleted separately before that is not content, in either case.
 *
 * Runs the `OnCopy` hooks over every pair (the page rows included) in the same
 * transaction, so what plugins key by block id — the text docs, authorship —
 * arrives with the rows. Returns the ids of the nested pages it created, which
 * the caller announces like any created page.
 *
 * `writtenIds` are the rows the same write already inserted. They, and every
 * row this copy inserts, are never read back as source content: pasting a copy
 * of a page INTO that page would otherwise find its own copy among the source's
 * rows and clone it again, without end.
 */
export async function copyPageContent(
  ctx: PageForestCtx,
  pairs: readonly { sourcePageId: string; copyPageId: string }[],
  writtenIds: ReadonlySet<string>,
): Promise<{ createdPageIds: string[] }> {
  const fresh = new Set(writtenIds);
  const copied: CopiedBlock[] = [];
  const createdPageIds: string[] = [];
  const queue: { source: string; copy: string; entryId: string | null }[] = [];

  for (const pair of pairs) {
    const [page] = await ctx.tx
      .select({ trashEntryId: _blocks.trashEntryId })
      .from(_blocks)
      .where(eq(_blocks.id, pair.sourcePageId))
      .limit(1);
    // A purged source leaves an empty page — still a faithful copy of nothing.
    if (page === undefined) continue;
    copied.push({
      sourceId: pair.sourcePageId,
      copyId: pair.copyPageId,
      type: PAGE_BLOCK_TYPE,
    });
    queue.push({
      source: pair.sourcePageId,
      copy: pair.copyPageId,
      entryId: page.trashEntryId,
    });
  }

  const now = new Date();
  while (queue.length > 0) {
    const { source, copy, entryId } = queue.shift()!;
    const rows = await ctx.tx
      .select()
      .from(_blocks)
      .where(eq(_blocks.pageId, source));
    const content = rows.filter(
      (r) =>
        !fresh.has(r.id) &&
        (entryId === null ? r.deletedAt === null : r.trashEntryId === entryId),
    );

    // Walk from the page down, so a row is only copied when its whole parent
    // chain is (an orphan under a separately-deleted parent is not content), and
    // the inserts come out parent-before-descendant for the self-FK.
    const childrenOf = new Map<string, typeof content>();
    for (const r of content) {
      if (r.parentId === null) continue;
      const list = childrenOf.get(r.parentId);
      if (list) list.push(r);
      else childrenOf.set(r.parentId, [r]);
    }
    const inserts: NewBlockRow[] = [];
    const frontier: { sourceId: string; copyId: string }[] = [
      { sourceId: source, copyId: copy },
    ];
    while (frontier.length > 0) {
      const parent = frontier.shift()!;
      for (const r of childrenOf.get(parent.sourceId) ?? []) {
        const id = newBlockId();
        fresh.add(id);
        inserts.push({
          id,
          pageId: copy,
          parentId: parent.copyId,
          type: r.type,
          data: parseBlockData(r.type, r.data),
          rank: r.rank,
          expanded: r.expanded,
          createdAt: now,
        });
        copied.push({ sourceId: r.id, copyId: id, type: r.type });
        if (r.type === PAGE_BLOCK_TYPE) {
          // A nested page's own content lives in ITS partition, not under its
          // `parent_id` children here; clone it as a page of its own.
          createdPageIds.push(id);
          queue.push({ source: r.id, copy: id, entryId });
        } else {
          frontier.push({ sourceId: r.id, copyId: id });
        }
      }
    }
    await insertBlocks(ctx.tx, inserts);
  }

  if (copied.length > 0) {
    for (const hook of BlockLifecycle.OnCopy.getContributions()) {
      await hook.onCopy(copied, ctx.tx);
    }
  }
  return { createdPageIds };
}

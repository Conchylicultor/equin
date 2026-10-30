import { and, eq } from "drizzle-orm";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import type { RankExecutor } from "@plugins/primitives/plugins/rank/server";
import { db } from "@plugins/database/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import {
  PAGE_BLOCK_TYPE,
  pageData,
  pageKindOf,
  withPageKind,
} from "../../core";
import type { PageData } from "../../core";
import type { BlockNode } from "../../core";
import { newBlockId } from "../../core";
import { hasTextKey } from "../../core";
import { runsOf, type RichText } from "../../core";
import { dataEqual } from "../../core";
import { liveBlocks } from "./live-blocks";
import { loadPageBlocks } from "./forest";
import {
  withPageForest,
  pageScopesOf,
  type ForestExecutor,
} from "./page-forest";
import {
  existingBlockIdsAmong,
  updateBlockFields,
  writeForestTarget,
} from "./forest-writer";
import { rowToNode } from "./reconcile";
import { notifyBlockChange } from "./notify";
import { notifyStructuralChange } from "./notify-structural-change";
import { parseBlockData, rewriteBlockData } from "./parse-block-data";
import type { BlockReadExecutor } from "./page-id";
import { pageBlocksEntriesAmong, restoreEntryById } from "./trash-blocks";

/**
 * A single stored content block, flattened to a portable row. Carries the
 * stable `id` + `parentId` so a consumer can both rebuild the tree and diff two
 * snapshots by identity (text edits keep the same id; structural splits mint
 * new ones). Domain-neutral: no rank math leaks out — `rank` is the raw stored
 * string, only meaningful for ordering siblings.
 */
export interface StoredBlock {
  id: string;
  parentId: string | null;
  type: string;
  data: unknown;
  rank: string;
  expanded: boolean;
}

/**
 * A portable snapshot of a page's full content: its page-level metadata plus
 * every content block as a flat row (with ids). General-purpose — usable for
 * version history, export, duplicate-page, and templating.
 */
export interface PageContentSnapshot {
  page: PageData;
  blocks: StoredBlock[];
}

/**
 * Serialize a page's full content (page-data + all content blocks) to a
 * portable {@link PageContentSnapshot}. Reuses {@link loadPageBlocks}; rows are
 * returned flat with their stable ids so callers can rebuild the tree or diff
 * by identity. Returns `null` if the page block doesn't exist (e.g. it was
 * deleted) so callers — like a debounced snapshot job — can skip cleanly rather
 * than treat a vanished page as an error.
 */
export async function serializePageContent(
  pageId: string,
  executor: RankExecutor = db,
): Promise<PageContentSnapshot | null> {
  const [pageBlock] = await executor
    .select()
    .from(liveBlocks)
    .where(and(eq(liveBlocks.id, pageId), eq(liveBlocks.type, PAGE_BLOCK_TYPE)))
    .limit(1);
  if (!pageBlock) return null;
  const rows = await loadPageBlocks(pageId, executor);
  return {
    page: pageData(pageBlock),
    blocks: rows.map((r) => ({
      id: r.id,
      parentId: r.parentId,
      type: r.type,
      data: r.data,
      rank: r.rank,
      expanded: r.expanded,
    })),
  };
}

/** One block whose content doc the restore's text phase brings to `runs`. */
interface BlockTextEdit {
  blockId: string;
  runs: RichText;
}

/**
 * Writes blocks' text — their content docs first, then each row's `data.text`
 * projection — after a structural write has committed. The editor cannot
 * implement this itself (the server-side text writer imports the editor, so
 * the editor importing it back would be a cycle); the caller hands it in.
 * `page/block-text-write`'s `writeBlockTexts` is the one implementation.
 */
export type BlockTextWriter = (
  pageId: string,
  edits: readonly { blockId: string; runs: RichText }[],
) => Promise<void>;

/**
 * Make page `pageId` read like `snapshot` again — the history-restore write.
 * Reverse of {@link serializePageContent}.
 *
 * **Blocks are matched by id.** Nothing the user can see is hard-deleted:
 *  - a block in both the page and the version KEEPS its id, its `created_at`
 *    and its content doc; the doc is edited to the version's text, never
 *    replaced, so an open editor stays mounted and only sees a CRDT merge;
 *  - a block deleted since the version comes back as ITSELF (its trash entry is
 *    restored), with its surviving doc byte-exact;
 *  - a block created since the version is TRASHED, under one `page-blocks`
 *    entry, so restoring the "Before restore" version brings it back the same
 *    way.
 *
 * **Three phases**, the two-channel order every server-side content writer
 * follows (structure, then docs, then the text projection):
 *
 *  0. The page must be live — a missing or trashed page is a 404.
 *  1. **Revive**, before the lock (the patch handler's un-trash prelude does
 *     the same): each `page-blocks` entry holding a version block trashed from
 *     this page is restored whole. A row the entry holds that the version does
 *     not is trashed again by phase 2, under the restore's own entry.
 *  2. **Structure**, under the page lock: compute the target forest from the
 *     version and what is live now ({@link planRestoreTarget}), then write it
 *     with the op handler's own shape, {@link writeForestTarget}. The page row's
 *     own `data` (title, icon, cover) is set from `snapshot.page` — all but its
 *     kind (author, instructions, global), which stays the stored row's (a
 *     version never changes what the page is to agents; only `setPageKind` does).
 *  3. **Text**: `io.writeTexts` edits every text-bearing surviving block's doc
 *     to the version's runs, then projects `data.text`. Required rather than
 *     returned for the caller to apply: forgetting it would restore structure
 *     but not text, silently, and a required parameter makes that a tsc error.
 *
 * **Sub-pages are never touched.** A restore never creates, revives, deletes or
 * renames a sub-page. A live sub-page's row may only MOVE: back to its version
 * position when it has one, else it stays where it is, else it goes to the end
 * of the page's top level. Its `data` (title, icon) is always its current row's.
 *
 * **Re-running converges.** Every phase is a function of the version and the
 * current state, so a restore interrupted after phase 2 (a text-phase failure)
 * finishes when run again. A second run over a page the first run completed
 * writes no structure and mints no trash entry — except for fresh-id COPIES
 * (below), which a second run re-mints, trashing the first run's copies.
 *
 * `executor` is the global handle in production and a throwaway DB in tests;
 * it is not a transaction — each phase opens its own.
 */
export async function restorePageContent(
  pageId: string,
  snapshot: PageContentSnapshot,
  io: { writeTexts: BlockTextWriter },
  executor: ForestExecutor = db,
): Promise<void> {
  // --- Phase 0: the page must be live --------------------------------------
  await requireLivePage(executor, pageId);

  // --- Phase 1: revive the version's blocks trashed from this page ---------
  // Sub-page shells are excluded here: a shell is only ever trashed in a
  // `pages` entry, which a restore never revives anyway.
  const versionContentIds = snapshot.blocks
    .filter((b) => b.type !== PAGE_BLOCK_TYPE)
    .map((b) => b.id);
  const entryIds = await pageBlocksEntriesAmong(
    executor,
    pageId,
    versionContentIds,
  );
  for (const entryId of entryIds) {
    await restoreEntryById(entryId, executor);
  }

  // --- Phase 2: the target forest, written under the lock -------------------
  // Two forests are locked: this page's content, and the one its own row sits
  // in (the write sets that row's `data` — the title the parent and sidebar
  // render). `pageScopesOf` resolves the second.
  const scopes = [pageId, ...(await pageScopesOf(executor, [pageId]))];
  const { value } = await withPageForest(
    scopes,
    async (ctx) => {
      const pageRow = await requireLivePage(ctx.tx, pageId);
      // `forest()` spans every locked scope; the parent page's rows are not
      // this restore's to write, so only this page's partition is `before`.
      const before = (await ctx.forest())
        .filter((r) => r.pageId === pageId)
        .map(rowToNode);
      const beforeIds = new Set(before.map((n) => n.id));
      const taken = await existingBlockIdsAmong(
        ctx.tx,
        snapshot.blocks.filter((b) => !beforeIds.has(b.id)).map((b) => b.id),
      );
      const plan = planRestoreTarget({
        pageId,
        version: snapshot.blocks,
        before,
        taken,
      });

      const write = await writeForestTarget(ctx, before, plan.after);
      if (write.deferredToChokepoint) {
        // Unreachable by construction: the target keeps every live sub-page
        // shell, so the delete set holds no page row, and a page-free set is
        // always trashed inline.
        throw new Error(
          `[page-editor] restore of page ${pageId}: the delete set holds a sub-page (${write.deleteRootIds.join(", ")}) — the target must keep every live shell`,
        );
      }

      // A version restores the page's content, title, icon and cover — never
      // its KIND, the same way it never moves the page. The kind (agent page,
      // instructions page and its `global`) is changed only by the header's
      // control (`setPageKind`), so a version taken before a change holds
      // another one; the stored row's kind is carried onto the version's data
      // instead. The result is still a REWRITE of the stored data and judged as
      // one (`rewriteBlockData`), which it now passes by construction.
      const next = withPageKind(snapshot.page, pageKindOf(pageData(pageRow)));
      const data = rewriteBlockData({
        type: PAGE_BLOCK_TYPE,
        before: { type: PAGE_BLOCK_TYPE, data: pageRow.data },
        next,
      });
      if (!dataEqual(pageRow.data, data)) {
        await updateBlockFields(ctx.tx, pageId, { data });
      }

      return {
        deletedRows: write.deletedRows,
        createdPageIds: write.createdPageIds,
        textEdits: plan.textEdits,
        pageScope: pageRow.pageId,
      };
    },
    executor,
  );

  await notifyStructuralChange(
    {
      pageId,
      deletedRows: value.deletedRows,
      createdPageIds: value.createdPageIds,
    },
    executor,
  );
  // The page row's own data (title, cover): its cover links are scoped to its
  // own id, and its title renders in the forest it sits in.
  await notifyBlockChange(
    { pageId: value.pageScope, type: PAGE_BLOCK_TYPE, blockId: pageId },
    executor,
  );

  // --- Phase 3: text --------------------------------------------------------
  try {
    await io.writeTexts(pageId, value.textEdits);
  } catch (err) {
    throw new Error(
      `[page-editor] restore of page ${pageId}: the text phase failed after ` +
        `the structure was committed. Re-running the restore converges.`,
      { cause: err },
    );
  }
}

/** The page row a restore writes, read live — or a 404. */
async function requireLivePage(
  executor: BlockReadExecutor,
  pageId: string,
): Promise<{ pageId: string | null; data: unknown }> {
  const [row] = await executor
    .select({ pageId: liveBlocks.pageId, data: liveBlocks.data })
    .from(liveBlocks)
    .where(and(eq(liveBlocks.id, pageId), eq(liveBlocks.type, PAGE_BLOCK_TYPE)))
    .limit(1);
  if (!row) {
    throw new HttpError(
      404,
      `Cannot restore page ${pageId}: it does not exist or is in the trash`,
    );
  }
  return row;
}

/** What {@link planRestoreTarget} decided. */
interface RestoreTarget {
  /** The page's forest as the restore leaves it — `writeForestTarget`'s `after`. */
  after: BlockNode[];
  /** One per text-bearing survivor: the version's runs, for the text phase. */
  textEdits: BlockTextEdit[];
}

const pairKey = (parentId: string | null, rank: string): string =>
  `${parentId ?? ""}\u0000${rank}`;

/**
 * The target forest of a restore, as a pure function of the version, the
 * page's live rows (`before`) and which ids exist anywhere at all (`taken`,
 * asked only about version ids that are not live on the page).
 *
 * **Content rows**, walked top-down from the page so every row's parent is in
 * the target first (a version row no walk reaches is dropped):
 *
 * | version row | state now | target |
 * |---|---|---|
 * | content | live here, content type | SURVIVOR — same id |
 * | content | no row with that id anywhere (purged) | re-inserted with its ORIGINAL id |
 * | content | taken: live on another page, trashed and not revived, or live here as a sub-page (turned into a page since) | a fresh-id COPY |
 *
 * `parentId` (through the copies' id map), `type`, `rank` and `expanded` always
 * come from the version. A survivor's `data` is the version's too, except its
 * TEXT: when both carry `text`, the current one is kept, because the structural
 * write never changes a projection — the text phase edits the doc and projects
 * it. A block that turned from void back into text-bearing carries the
 * version's text (a text-bearing row needs one). Every text-bearing survivor
 * gets a text edit. A re-inserted or copied row carries the version's text as
 * its seed and gets no edit: it has no doc to edit.
 *
 * **Live sub-page shells** are all kept — a restore never removes one — and
 * keep their CURRENT `data`: writing the version's back would rename a live
 * sub-page. Only their place can change:
 *  1. a shell in the version goes to its version position (its parent is in
 *     the target, or the walk would not have reached it);
 *  2. else it keeps its current place, if that parent is in the target (or is
 *     the page) and no target row claims the same `(parent, rank)`;
 *  3. else it goes to the page's top level, above every target rank there.
 * A version shell that is not live here is dropped: a restore never mints a
 * sub-page.
 *
 * Every other live row of the page is left out of the target — the write
 * trashes it.
 *
 * The target's `(parent, rank)` pairs are unique: content pairs come from one
 * valid version, and rules 2 and 3 only ever take a free pair.
 */
function planRestoreTarget(args: {
  pageId: string;
  version: readonly StoredBlock[];
  before: readonly BlockNode[];
  taken: ReadonlySet<string>;
}): RestoreTarget {
  const { pageId, version, before, taken } = args;
  const beforeById = new Map(before.map((n) => [n.id, n]));
  const childrenOf = new Map<string | null, StoredBlock[]>();
  for (const v of version) {
    const list = childrenOf.get(v.parentId);
    if (list) list.push(v);
    else childrenOf.set(v.parentId, [v]);
  }

  const after: BlockNode[] = [];
  const textEdits: BlockTextEdit[] = [];
  const contentIds = new Set<string>();
  /** Where each version shell sits in the target, by shell id. */
  const shellPositions = new Map<string, { parentId: string; rank: string }>();

  const visit = (v: StoredBlock, parentId: string): void => {
    if (v.type === PAGE_BLOCK_TYPE) {
      // Its own content is another page's partition, so it has no children
      // here to walk.
      shellPositions.set(v.id, { parentId, rank: v.rank });
      return;
    }
    const current = beforeById.get(v.id);
    let id: string;
    let data: unknown;
    if (current && current.type !== PAGE_BLOCK_TYPE) {
      id = v.id;
      const keepText = hasTextKey(v.data) && hasTextKey(current.data);
      data = keepText
        ? {
            ...(v.data as Record<string, unknown>),
            text: (current.data as { text: unknown }).text,
          }
        : v.data;
      if (hasTextKey(v.data)) {
        textEdits.push({
          blockId: id,
          runs: runsOf((v.data as { text: unknown }).text),
        });
      }
    } else if (!current && !taken.has(v.id)) {
      id = v.id;
      data = v.data;
    } else {
      id = newBlockId();
      data = v.data;
    }
    after.push({
      id,
      pageId,
      parentId,
      type: v.type,
      // Validated here rather than at the write so a version the schema no
      // longer accepts fails before anything is written, and so an unchanged
      // survivor compares equal to its stored (already validated) data.
      data: parseBlockData(v.type, data),
      rank: v.rank,
      expanded: v.expanded,
    });
    contentIds.add(id);
    for (const child of childrenOf.get(v.id) ?? []) visit(child, id);
  };
  for (const top of childrenOf.get(pageId) ?? []) visit(top, pageId);

  // --- Live sub-page shells: every one is kept; only its place may change --
  const claimed = new Set(after.map((n) => pairKey(n.parentId, n.rank)));
  const shells = before
    .filter((n) => n.type === PAGE_BLOCK_TYPE)
    .sort((a, b) => Rank.compare(Rank.from(a.rank), Rank.from(b.rank)));
  const placed: BlockNode[] = [];
  const unplaced: BlockNode[] = [];
  // Rule 1 first, so a shell keeping its current place (rule 2) can never take
  // a pair a shell returning to its version position needs.
  for (const shell of shells) {
    const position = shellPositions.get(shell.id);
    if (position) {
      placed.push({ ...shell, ...position });
      claimed.add(pairKey(position.parentId, position.rank));
    } else {
      unplaced.push(shell);
    }
  }
  const rehomed: BlockNode[] = [];
  for (const shell of unplaced) {
    const parentKept =
      shell.parentId === pageId ||
      (shell.parentId !== null && contentIds.has(shell.parentId));
    const key = pairKey(shell.parentId, shell.rank);
    if (parentKept && !claimed.has(key)) {
      placed.push(shell);
      claimed.add(key);
    } else {
      rehomed.push(shell);
    }
  }
  // Rule 3: above the highest rank the target has at the page's top level.
  const topRanks = [...after, ...placed]
    .filter((n) => n.parentId === pageId)
    .map((n) => Rank.from(n.rank));
  const highest = topRanks.reduce<Rank | null>(
    (max, r) => (max === null || Rank.compare(r, max) > 0 ? r : max),
    null,
  );
  const ranks = Rank.nBetween(highest, null, rehomed.length);
  rehomed.forEach((shell, i) => {
    placed.push({ ...shell, parentId: pageId, rank: ranks[i]!.toJSON() });
  });

  return { after: [...after, ...placed], textEdits };
}

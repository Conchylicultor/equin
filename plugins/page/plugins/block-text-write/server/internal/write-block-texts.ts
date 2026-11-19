import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "@plugins/database/server";
import { loadBlockDocs } from "@plugins/page/plugins/editor-collab/server";
import {
  applyPageBlockPatch,
  liveBlocks,
} from "@plugins/page/plugins/editor/server";
import {
  runsOfNode,
  type BlockUpdate,
  type RichText,
} from "@plugins/page/plugins/editor/core";
import { sameRuns, writeBlockText } from "./block-doc-text";

/** One block whose text a server-side write brings to `runs`. */
export interface BlockTextEdit {
  blockId: string;
  runs: RichText;
}

/** The columns this write reads off a live row. */
interface LiveRow {
  id: string;
  type: string;
  data: unknown;
}

/**
 * Bring each named block of page `pageId` to its `runs` — the doc, then the
 * row's `data.text` projection. THE text channel for every server-side content
 * writer (markdown apply, history restore): call it AFTER the structural write
 * has committed, with every text-bearing block whose text that write means to
 * set.
 *
 * ---------------------------------------------------------------------------
 * Order: every doc before any row
 * ---------------------------------------------------------------------------
 *
 *  1. **Docs**, per block, through {@link writeBlockText}: splice a stored doc
 *     to the target runs, or seed a missing one first-writer-wins. After the
 *     structure, never before: `page_block_docs.block_id` FKs onto
 *     `page_blocks.id`, so a block the structural write just created has no row
 *     to hang a doc off until it commits.
 *  2. **Rows**, in ONE `applyPageBlockPatch`: each update sets `data` to the
 *     row's CURRENT data with `text` replaced. `data.text` is a PROJECTION of
 *     the doc, so it is written downstream of it and never ahead: a failure in
 *     step 1 leaves every row as it was.
 *
 * **The projection is not optional.** The browser's `useTextProjection` needs a
 * MOUNTED editor, so a doc written for a page nobody has open would leave
 * `data.text` stale forever — and search, backlinks, version history and
 * `read-only-view` all read that column. This writes the value a mounted client
 * eventually would, so a later client flush is an empty diff rather than a
 * fight.
 *
 * ---------------------------------------------------------------------------
 * What it costs, and what it skips
 * ---------------------------------------------------------------------------
 *
 * Every edited block's stored doc is loaded in ONE query (`loadBlockDocs`) and
 * its row in another, rather than one round trip per block — a history restore
 * names every text-bearing block of the page. Two skips then keep a large,
 * mostly-unchanged page cheap, and both are the same equality `writeBlockText`
 * already applies to a doc ({@link sameRuns}):
 *
 *  - **A block with NO stored doc whose row already reads the target runs is
 *    left completely alone** — no seed, no row write. Its row IS its seed: the
 *    first editor to open it seeds the doc from `data.text`, which already says
 *    the target. Seeding it here would mint a doc for every never-opened block
 *    of the page and change nothing anyone can read.
 *  - **A row that already reads the target is not rewritten**, whatever its
 *    doc needed. The projection's job is to make the row say the runs; a row
 *    that says them has nothing to write.
 *
 * ---------------------------------------------------------------------------
 * Failure: idempotence IS the recovery story
 * ---------------------------------------------------------------------------
 *
 * Throws loudly, naming the block, and can leave some docs written and no row
 * projected. That is recoverable rather than corrupt because every step here is
 * a pure function of CURRENT state: a doc that already reads as the target is
 * untouched, a row that already reads it is untouched, so re-running the same
 * write converges. There is deliberately no retry loop and no compensating
 * rollback.
 *
 * A named block that is not a live block of `pageId` — deleted concurrently, or
 * never on this page — is refused loudly rather than skipped, before anything is
 * written when the read up front can see it, and before the projection when it
 * went between the two reads.
 */
export async function writeBlockTexts(
  pageId: string,
  edits: readonly BlockTextEdit[],
  executor: NodePgDatabase = db,
): Promise<void> {
  if (edits.length === 0) return;
  const ids = edits.map((e) => e.blockId);
  if (new Set(ids).size !== ids.length) {
    // Two targets for one block have no order between them, and the second
    // would splice a doc state the first has already moved past.
    throw new Error(
      `block text write: page ${pageId} names a block more than once ` +
        `(${ids.filter((id, i) => ids.indexOf(id) !== i).join(", ")}).`,
    );
  }

  // One query for every stored doc, one for every row — never one per block.
  const [docs, before] = await Promise.all([
    loadBlockDocs(executor, ids),
    loadLiveRows(executor, pageId, ids),
  ]);
  assertAllLive(pageId, ids, before, "nothing was written");

  const pending = edits.filter(
    (e) =>
      docs.has(e.blockId) ||
      !sameRuns(runsOfNode(before.get(e.blockId)!), e.runs),
  );

  // --- 1. The docs ----------------------------------------------------------
  for (const edit of pending) {
    await writeBlockText(
      executor,
      edit.blockId,
      edit.runs,
      docs.get(edit.blockId),
    ).catch((err: unknown) => {
      throw new Error(
        `block text write: could not write the content doc of block ` +
          `${edit.blockId} on page ${pageId}. Structure is already committed; ` +
          `re-running the same write converges (every step is a pure function ` +
          `of current state).`,
        { cause: err },
      );
    });
  }

  // --- 2. The row projections, as ONE patch --------------------------------
  // Re-read, not the rows loaded above: an update restates the whole `data`
  // blob, so it must restate what the row holds NOW — a field another writer
  // set while the docs were being written (a to-do's `checked`) would otherwise
  // be written back over.
  const pendingIds = pending.map((e) => e.blockId);
  const now = await loadLiveRows(executor, pageId, pendingIds);
  assertAllLive(
    pageId,
    pendingIds,
    now,
    "the docs were written but no row was projected",
  );
  const updates: BlockUpdate[] = pending.flatMap((edit) => {
    const row = now.get(edit.blockId)!;
    return sameRuns(runsOfNode(row), edit.runs)
      ? []
      : [
          {
            id: row.id,
            ofType: row.type,
            changes: { data: projectedData(row.data, edit.runs) },
          },
        ];
  });
  if (updates.length > 0) {
    await applyPageBlockPatch(
      pageId,
      { creates: [], updates, deleteIds: [] },
      executor,
    );
  }
}

/** The live rows of `pageId` among `ids`, by id. */
async function loadLiveRows(
  executor: NodePgDatabase,
  pageId: string,
  ids: readonly string[],
): Promise<Map<string, LiveRow>> {
  if (ids.length === 0) return new Map();
  const rows = await executor
    .select({ id: liveBlocks.id, type: liveBlocks.type, data: liveBlocks.data })
    .from(liveBlocks)
    .where(
      and(eq(liveBlocks.pageId, pageId), inArray(liveBlocks.id, [...ids])),
    );
  return new Map(rows.map((r) => [r.id, r] as const));
}

/**
 * Loud rather than skipped. A re-run will simply not name a block that is gone,
 * so this self-heals — but a write that silently dropped part of its target is
 * worth knowing about.
 */
function assertAllLive(
  pageId: string,
  ids: readonly string[],
  rows: ReadonlyMap<string, LiveRow>,
  state: string,
): void {
  const gone = ids.filter((id) => !rows.has(id));
  if (gone.length > 0) {
    throw new Error(
      `block text write: block(s) ${gone.join(", ")} are not live blocks of ` +
        `page ${pageId} (a concurrent delete?); ${state}.`,
    );
  }
}

/** The `data` blob a text projection writes: the row's own, `text` replaced. */
function projectedData(data: unknown, text: RichText): unknown {
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? { ...(data as Record<string, unknown>), text }
    : { text };
}

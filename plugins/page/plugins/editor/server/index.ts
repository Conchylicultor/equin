import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { defineTrashSource } from "@plugins/infra/plugins/trash/server";
import { IdKinds } from "@plugins/ids/server";
import { DerivedTable } from "@plugins/database/plugins/derived-tables/server";
import { blockIdKind } from "../core/block-id";
import { handleListPages } from "./internal/handle-list-pages";
import { handleListBlocks } from "./internal/handle-list-blocks";
import { handleGetBlockPage } from "./internal/handle-get-block-page";
import { handleCreateBlock } from "./internal/handle-create-block";
import { handleUpdateBlock } from "./internal/handle-update-block";
import { handleDeleteBlock } from "./internal/handle-delete-block";
import { handleMoveBlock } from "./internal/handle-move-block";
import { handleMoveBlocks } from "./internal/handle-move-blocks";
import { handleTurnIntoPage } from "./internal/handle-turn-into-page";
import { handleSetPageKind } from "./internal/handle-set-page-kind";
import { handleApplyBlockOp } from "./internal/handle-apply-block-op";
import { handlePatchBlocks } from "./internal/handle-patch-blocks";
import {
  blockLocationsServed,
  pagesTreeServed,
  pageBlocksServed,
} from "./internal/resources";
import { pageContentEditedAt } from "./internal/rollup-spec";
import {
  restoreTrashedBlocks,
  purgeTrashedBlocks,
} from "./internal/trash-blocks";
import { blocksChanged } from "./internal/tables-events";
import { Editor } from "./internal/block-registry";
import { resolvePageTitleAnnotations } from "./internal/page-title-annotations";
import { reconcileDocRanksAndAnnounceDrift } from "./internal/doc-rank-drift-sink";
import {
  pageBlockHandle,
  PAGES_TRASH_SOURCE,
  PAGE_BLOCKS_TRASH_SOURCE,
} from "../core/schemas";
import {
  listPages,
  listBlocks,
  getBlockPage,
  createBlock,
  updateBlock,
  deleteBlock,
  moveBlock,
  moveBlocks,
  turnIntoPage,
  setPageKind,
  applyBlockOpEndpoint,
  patchBlocks,
} from "../core/endpoints";

export { _blocks } from "./internal/tables";
// The LIVE relation every reader takes (`page_blocks WHERE deleted_at IS NULL`,
// the predicate never spelled). `_blocks` itself is for the trash machinery —
// `page-editor/no-unfiltered-blocks-read` flags any other read of it.
export { liveBlocks } from "./internal/live-blocks";
export { blocksChanged } from "./internal/tables-events";
export type { BlocksChangedPayload } from "./internal/tables-events";
export { BlockLifecycle } from "./internal/document-hooks";
export type {
  AfterCommit,
  BlockCopyHook,
  BlockCreateHook,
  BlockDeleteHook,
  CopiedBlock,
  BlockRestoreHook,
  BlockTrashHook,
  DeletedBlockRow,
} from "./internal/document-hooks";
export type { PageForestTx } from "./internal/page-forest";
// Where the boot reconcile announces doc-rank drift (`reports/page-doc-rank-drift`
// files it): a sink, so this barrel — loaded by drizzle-kit through `_blocks` —
// never imports `reports`.
export { docRankDriftSink } from "./internal/doc-rank-drift-sink";
export type { DocRankDrift } from "./internal/doc-rank-drift-sink";
// The delete chokepoint and its inverse: every block delete is a trash, and a
// consumer that trashed through the chokepoint restores through this.
export { deleteBlocksSubtree } from "./internal/trash-blocks";
export {
  BlockSchema,
  PageDataSchema,
  PAGE_BLOCK_TYPE,
  pageData,
} from "../core/schemas";
export type { Block, PageData } from "../core/schemas";
// History restore's read and write. The write keeps block identity and edits
// text through a writer the caller hands in (`page/block-text-write`).
export {
  serializePageContent,
  restorePageContent,
} from "./internal/page-content";
// The one sanctioned forest write for a caller holding a computed `BlockPatch`
// (`page-editor/no-adhoc-forest-write` forbids every other route into `_blocks`).
export { applyPageBlockPatch } from "./internal/handle-patch-blocks";
// A page row's title, written server-side under the page's lock — an agent's
// rename through `edit_page`'s `# Title` line. `requireAuthor` is judged under
// that lock, so a page flipped to the human's mid-rename refuses (409).
export { renamePage } from "./internal/rename-page";
// A page row's emoji icon, written server-side under the page's lock (the
// auto-icon job's write-back). `onlyIfUnset` never overwrites a user's pick.
export { setPageIcon } from "./internal/set-page-icon";
// When a page was last edited (its row and its live content) — the value behind
// the page-detail "Edited" label, for a server reader stating the same time.
export { readPageEditedAt } from "./internal/resources";
export type {
  BlockTextWriter,
  PageContentSnapshot,
  StoredBlock,
} from "./internal/page-content";
export {
  Editor,
  blockTextProtectedSpans,
  blockTextServerExtensions,
  blockTextServerNodes,
  resolveBlockAnnotations,
} from "./internal/block-registry";

export default {
  description: "Block-based document editor — tables, routes, and live state.",
  // Bring every sidebar group's `doc_rank` to document order before this
  // backend serves: the first boot of a database backfills the column, and any
  // later boot that still finds work has found a writer that bypassed the
  // doc-order marks — repaired here, and announced on `docRankDriftSink`.
  // After `database`'s barrier (a `dependsOn` edge), so the column exists;
  // idempotent.
  async onReadyBlocking() {
    await reconcileDocRanksAndAnnounceDrift();
  },
  httpRoutes: {
    [listPages.route]: handleListPages,
    [listBlocks.route]: handleListBlocks,
    [getBlockPage.route]: handleGetBlockPage,
    [createBlock.route]: handleCreateBlock,
    [updateBlock.route]: handleUpdateBlock,
    [deleteBlock.route]: handleDeleteBlock,
    [moveBlock.route]: handleMoveBlock,
    [moveBlocks.route]: handleMoveBlocks,
    [turnIntoPage.route]: handleTurnIntoPage,
    [setPageKind.route]: handleSetPageKind,
    [applyBlockOpEndpoint.route]: handleApplyBlockOp,
    [patchBlocks.route]: handlePatchBlocks,
  },
  register: [
    blocksChanged,
    // Two trash sources over ONE ledger mechanism — every block delete is a
    // trash. `pages` holds the entries page roots mint (what the Pages Trash
    // dialog lists); `page-blocks` holds the anchor entry a page-free delete
    // mints for its content rows (undo + purge only, no UI). Both restore by
    // clearing the rows' flags and consuming the entry (restoreTrashedBlocks →
    // untrashBlocks), and are hard-deleted only at purge (purgeTrashedBlocks
    // runs the OnDelete hooks + cascades).
    defineTrashSource({
      id: PAGES_TRASH_SOURCE,
      restore: restoreTrashedBlocks,
      purge: purgeTrashedBlocks,
    }),
    defineTrashSource({
      id: PAGE_BLOCKS_TRASH_SOURCE,
      restore: restoreTrashedBlocks,
      purge: purgeTrashedBlocks,
    }),
  ],
  contributions: [
    IdKinds.Kind({ kind: blockIdKind }),
    ...pagesTreeServed.declare,
    ...blockLocationsServed.declare,
    ...pageBlocksServed.declare,
    // The per-page content edit time `pagesTree`'s `editedAt` reads.
    DerivedTable(pageContentEditedAt),
    // `page` is owned here, not by the `sub-page` renderer: page rows are written
    // directly by turn-into-page / restorePageContent, so their validation must not
    // depend on the sub-page plugin being enabled. sub-page contributes only its web
    // renderer — a second `Editor.BlockData("page")` would be a duplicate → throw.
    Editor.BlockData(pageBlockHandle),
    // The read-only `title` on `<page id="…" title="…"/>` for a human sub-page —
    // its own row's. `page-link` answers for the links sharing the tag.
    Editor.BlockAnnotation({ resolve: resolvePageTitleAnnotations }),
  ],
} satisfies ServerPluginDefinition;

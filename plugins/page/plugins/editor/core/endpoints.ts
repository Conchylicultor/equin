import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { TrashOutcomeSchema } from "@plugins/infra/plugins/trash/core";
import { BlockSchema, PageKindSchema, PageRowSchema } from "./schemas";
import { BlockOpSchema } from "./block-ops";
import { BlockPatchSchema } from "./block-diff";

export const CreateBlockBodySchema = z.object({
  parentId: z.string().nullable().optional(),
  type: z.string(),
  data: z.unknown().optional(),
  /**
   * When set, position the new block immediately after this existing block —
   * same parent, rank between it and its next sibling. Overrides `parentId`.
   *
   * This is the ONLY positional mechanism: no caller may hand the server a rank.
   * `page_blocks` has one ordering space `(parent_id, rank)` that several live
   * resources project *disjointly* (the sidebar sees only `type='page'` rows,
   * the editor sees the rest), so a client minting a fractional key over the
   * rows it can see collides with the siblings it cannot. The server computes
   * every rank against the complete sibling set.
   */
  afterId: z.string().optional(),
});
export type CreateBlockBody = z.infer<typeof CreateBlockBodySchema>;

export const UpdateBlockBodySchema = z.object({
  type: z.string().optional(),
  data: z.unknown().optional(),
  expanded: z.boolean().optional(),
});
export type UpdateBlockBody = z.infer<typeof UpdateBlockBodySchema>;

/**
 * Positional intent, never a rank (see `CreateBlockBodySchema.afterId`). The
 * block lands among `parentId`'s children, immediately `zone` of `targetId`.
 *
 * The EDITOR surface no longer posts this for an ordinary drag — a same-page
 * move is a `BlockOp` on the ordered op stream. Two callers remain, and both are
 * writes no single page's optimistic overlay can predict: the Pages sidebar
 * (a different surface over the derived `docRank` order) and the composite
 * editor's CROSS-PAGE drop, which permutes two pages' forests at once.
 *
 * `targetId: null` addresses the sibling-list boundary instead of a neighbour:
 * `"after"` appends at the end of `parentId`'s children, `"before"` prepends at
 * the start. That is what a tree "drop onto this row as a child" gesture means.
 * A non-null `targetId` MUST already be a child of `parentId`.
 */
export const MoveBlockBodySchema = z.object({
  parentId: z.string().nullable(),
  targetId: z.string().nullable(),
  zone: z.enum(["before", "after"]),
});
export type MoveBlockBody = z.infer<typeof MoveBlockBodySchema>;

// Pages are blocks of `type="page"`, in document order per sidebar sibling group
// and carrying the stored `docRank` — the column the live `pagesTree` set serves
// too, read off `(page_id, doc_rank)`. Deliberately not the plain rank sort it
// used to be: `rank` is only comparable within one `(parent_id, rank)` space,
// and a page's sidebar siblings can span several, so a second definition of
// "the pages list" here would be a second, wrong order for one concept.
export const listPages = defineEndpoint({
  route: "GET /api/pages",
  response: z.array(PageRowSchema),
});

// A page's content: non-page blocks scoped by `pageId`, ordered by rank.
export const listBlocks = defineEndpoint({
  route: "GET /api/pages/:pageId/blocks",
  response: z.array(BlockSchema),
});

// Which page an arbitrary block id opens: the row itself when it IS a page,
// its denormalized nearest page ancestor otherwise. `found: false` is the
// legitimate "there is no page to open" answer — an unknown id, a trashed row,
// or a page-less block at the forest root — NOT an error: every id-bearing
// surface outside the editor (a link written in a conversation, a stale
// bookmark) is allowed to name a block that is gone.
export const BlockPageSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    pageId: z.string(),
    isPage: z.boolean(),
    // The block's own type, so a surface can NAME the block (its type's label,
    // e.g. "TODO") before the page holding it has loaded.
    type: z.string(),
  }),
]);
export type BlockPage = z.infer<typeof BlockPageSchema>;

// The reverse lookup the `pagesTree` set cannot answer: it carries only
// `type="page"` rows. The app reads it live (`blockLocations`, core/resources);
// this request/response form stays for the page-link e2e script
// (`active-data/page-link/e2e/page-link-verify.ts`), which reads it over HTTP.
export const getBlockPage = defineEndpoint({
  route: "GET /api/blocks/:id/page",
  response: BlockPageSchema,
});

// Create any block. A top-level page = `{ parentId: null, type: "page", data:
// { title, icon } }`. The server computes `pageId` from the parent.
export const createBlock = defineEndpoint({
  route: "POST /api/blocks",
  body: CreateBlockBodySchema,
  response: BlockSchema,
});

export const updateBlock = defineEndpoint({
  route: "PATCH /api/blocks/:id",
  body: UpdateBlockBodySchema,
  response: BlockSchema,
});

// Delete a block subtree. The server's chokepoint decides whether that is a
// TRASH (any `type="page"` block in the cascade set — soft delete, restorable)
// or a genuine hard delete (a page-free subtree), and says which: a `trashed`
// outcome carries the ledger handle (`sourceId` + `entryId`) the caller needs to
// restore it, which is what makes the sidebar's delete undoable.
export const deleteBlock = defineEndpoint({
  route: "DELETE /api/blocks/:id",
  response: TrashOutcomeSchema,
});

export const moveBlock = defineEndpoint({
  route: "POST /api/blocks/:id/move",
  body: MoveBlockBodySchema,
  response: BlockSchema,
});

/**
 * The selection twin of {@link MoveBlockBodySchema}: move a set of blocks (the
 * roots of a dragged selection, all on ONE page) under `parentId`, right after
 * `afterId` (or at the start of its children when null). Positional intent,
 * never a rank — the server runs `planBulkMove` against the destination's
 * complete live sibling set.
 *
 * Its one caller is the composite editor's CROSS-PAGE selection drop: the
 * `bulkMove` op cannot carry it, since its destination lies outside the op's
 * own page (the op endpoint refuses that with a 400), and no single page's
 * overlay can predict a write that moves rows out of its forest.
 */
export const MoveBlocksBodySchema = z.object({
  ids: z.array(z.string()).min(1),
  parentId: z.string().nullable(),
  afterId: z.string().nullable(),
});
export type MoveBlocksBody = z.infer<typeof MoveBlocksBodySchema>;

export const moveBlocks = defineEndpoint({
  route: "POST /api/blocks/move-many",
  body: MoveBlocksBodySchema,
  response: z.array(BlockSchema),
});

export const TurnIntoPageBodySchema = z.object({
  /**
   * The new page's title: a literal string (Turn into → Page passes the
   * block's own text, `/page` the line's other words), or `{ fromFirstChild:
   * true }` — the block's FIRST CHILD (by rank, live rows only) is CONSUMED:
   * its plain text, trimmed, becomes the title, the child row goes (a trash,
   * in the same transaction), and its own children take its slot at the head
   * of the page, order preserved. That is how a void container, whose first
   * line is its first child (an `<agent-inline>` card), becomes a page titled
   * with that line. A first child that holds no text (a sub-page, a nested
   * container, a media block) is not consumed and the title is `""`, as for a
   * childless block — its content is never dropped for a title it cannot give.
   */
  title: z.union([
    z.string(),
    z.object({ fromFirstChild: z.literal(true) }).strict(),
  ]),
  /**
   * Type + data for the empty content block seeded when the target block has no
   * children (a page with zero children renders nothing typeable). Supplied by
   * the caller because the editor must not import a concrete block type — the
   * same seam as `CreateBlockBodySchema.type`.
   */
  seedChild: z.object({ type: z.string(), data: z.unknown().optional() }),
  /**
   * The new page's KIND (`PageKind`) — `agent-page` is the `/agent-page` insert (a
   * human makes an empty page for an agent to fill, and its first writer counts
   * as its creator); `instructions` is the `/instructions page` insert. Absent is
   * an ordinary page, the human's. Chosen here at birth; afterwards only
   * {@link setPageKind} changes it (`rewriteBlockData` refuses a data write that
   * flips it).
   */
  kind: PageKindSchema.optional(),
});
export type TurnIntoPageBody = z.infer<typeof TurnIntoPageBodySchema>;

// Turn an existing block into a sub-page **in place**: set `type="page"` and
// `data={title, icon:null}` (the title literal, or consumed from the block's
// first child), seed `seedChild` when it is left with no children, and
// recompute `pageId` across the new page boundary for its whole subtree. The
// page row *is* the inline link — no separate `page-link` row is created.
export const turnIntoPage = defineEndpoint({
  route: "POST /api/blocks/:id/turn-into-page",
  body: TurnIntoPageBodySchema,
  response: BlockSchema,
});

/**
 * What the page becomes, as the whole of the request — see `PageKind`: an
 * ordinary page, an agent-authored page (agents may write all of it), or an
 * instructions page (the human's standing instructions to agents working under
 * its parent page), `global` when they are handed to every conversation at start.
 */
export const SetPageKindBodySchema = z.object({ kind: PageKindSchema });
export type SetPageKindBody = z.infer<typeof SetPageKindBodySchema>;

// Change a page's kind — the page header's kind control, and the ONE way a
// page's kind changes after it is born. A data write cannot carry the change
// (`rewriteBlockData` refuses it), and this op carries nothing else: title, icon,
// cover and every other key are copied from the stored row. Setting the kind a
// page already has is a no-op that returns the row.
export const setPageKind = defineEndpoint({
  route: "POST /api/blocks/:id/page-kind",
  body: SetPageKindBodySchema,
  response: BlockSchema,
});

// Single authoritative structural edit: load the page's blocks, apply the pure
// `applyBlockOp` reducer, reconcile + persist the diff, and return the resulting
// block list. Replaces the per-keystroke split/merge/indent/outdent endpoints.
export const applyBlockOpEndpoint = defineEndpoint({
  route: "POST /api/pages/:pageId/blocks/op",
  body: BlockOpSchema,
  // `watermark` is the commit's ack token (`currentTxId` read inside the write
  // transaction) — the optimistic overlay uses it for causal confirmation.
  response: z.object({ blocks: z.array(BlockSchema), watermark: z.string() }),
});

// Generic minimal-change patch: upsert the given full rows (insert-or-update by
// id) and delete the given ids, all in one transaction. Used by undo/redo to
// re-apply minimal forward/reverse changes onto the CURRENT document state (the
// command-pattern inverse path), so undoing an old action never clobbers later
// unrelated edits. The forward user actions keep their own specific endpoints.
export const patchBlocks = defineEndpoint({
  route: "POST /api/pages/:pageId/blocks/patch",
  body: BlockPatchSchema,
  response: z.object({ blocks: z.array(BlockSchema), watermark: z.string() }),
});

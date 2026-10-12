import { z } from "zod";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import { BlockSchema, PageRowSchema } from "./schemas";

// All live pages (`type="page"` blocks), the WHOLE set (`all`): the sidebar
// renders every page, and the `[[` / page-link pickers filter it by title
// locally; the by-id readers (the page header, cover and kind control, the
// link chips, the pane resolvers) read one row of it through `:rows`
// (`useLiveRow`). The sidebar tree is built by `pageId` (the nearest page
// ancestor — `parentId` may point at a content block) and ordered by `docRank`
// — the persisted, writer-derived document-order key (see `PageRowSchema`),
// NOT the raw storage `rank`; the set's own order is `createdAt`, which never
// changes, so a re-minted `docRank` is an in-place row refill, never an
// `orderOf`.
//
// Served over the `page_blocks` TABLE (`../server/internal/page-rows.ts`):
// a rename, an icon, cover or kind change is that page's refill, a re-mint the
// refill of exactly the re-minted pages, a create / restore an entrant, a trash
// an exit — and a write to a CONTENT block (the ~1s `data.text` typing
// projection) the refill of its page's ONE row: every row carries `editedAt`
// (`PageRowSchema`), read off a trigger-maintained rollup of its content's
// newest `updated_at` (`../server/internal/rollup-spec.ts`), so the edit moves
// it. A write the rollup does not read (a fold toggle) loads nothing.
//
// The key is NEW (`pages.tree`; it was the legacy push resource `pages`): a
// tab still running a bundle that subscribed the old key gets `unknown-key` — a
// `skew` verdict, the Reload prompt — rather than keyed deltas its non-keyed
// read cannot apply. Pinned by `../server/internal/pages-tree-oracle.test.ts`.
//
// Not preloaded: nothing reads it until the Pages app (or a page chip) mounts.
export const pagesTree = liveCollection("pages.tree", {
  row: PageRowSchema,
  id: "id",
  all: {
    orderBy: [["createdAt", "asc"]],
    unbounded: {
      reason:
        "the sidebar renders every page; the [[ and link pickers filter by title locally",
    },
  },
});

// A page's content forest: every block whose nearest page ancestor is
// `pageId`, sub-page rows included, pushed whole whenever it changes. A value
// rather than a collection: the editor's reducer, its optimistic overlay and
// document order all need EVERY block of the page (a window would truncate the
// document), and its loader reads through the `liveBlocks` subquery rather than
// one table's rows. Not known yet is `pending` — there is no `[]` placeholder.
export const pageBlocks = liveValue("page-blocks", {
  schema: z.array(BlockSchema),
  params: ["pageId"],
});

// Where a block lives — its type and its nearest page ancestor — for ANY live
// block, content blocks included: the reverse lookup `pagesTree` structurally
// cannot answer (it holds only page rows). Lookup-only (`:rows`, by id): a
// surface holding a bare block id (a transcript chip, the block pane) reads
// one row with `useLiveRow(blockLocations, id)`. Served over the `page_blocks`
// table with the live-block predicate (`deleted_at IS NULL`) as its base
// membership, so a trash is a where-flip exit (the row reads not found) and a
// restore an entrant. The point route reads only these columns, so the typing
// projection (a `data` write) loads nothing; a cross-page move or a
// turn-into-page refills the row.
export const BlockLocationSchema = z.object({
  id: z.string(),
  type: z.string(),
  // The nearest page ancestor; NULL for a page-less block at the forest root
  // (displayed by no page) — and, for a page row, the page it sits under.
  pageId: z.string().nullable(),
});
export type BlockLocation = z.infer<typeof BlockLocationSchema>;

export const blockLocations = liveCollection("page.block-locations", {
  row: BlockLocationSchema,
  id: "id",
});

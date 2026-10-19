import { z } from "zod";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import {
  liveCollection,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import { pagesEntityRef } from "@plugins/page/plugins/block-entity/core";
import { rankValueField } from "@plugins/fields/plugins/rank/plugins/config/core";
import type { Block, PageRow } from "./schemas";

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
//
// Declared by FIELDS: the rows ARE `page_blocks` rows (`from`), so every
// extension exposing fields of a block folds into them under `$columns` —
// starred, agent-origin and tags today, each served by its own plugin's
// `LiveColumns.Expose` and presented by its own `FieldPresentation`. A list
// (the sidebar) derives those fields; it names none of them. The one field a
// list shows of the row itself is `editedAt` (own: an expression over the
// rollup, bound by `columns` server-side); the title is a list's own
// projection of `data`. The row is otherwise carried, field for field the
// `PageRowSchema` the HTTP read keeps (pinned equal below).
export const pagesTree = liveCollection("pages.tree", {
  from: pagesEntityRef,
  fields: { editedAt: dateField({ label: "Edited" }) },
  carry: {
    pick: [
      "id",
      "pageId",
      "parentId",
      "type",
      "data",
      "expanded",
      "createdAt",
      "updatedAt",
    ],
    fields: {
      // The wire `Rank` value object over the stored key.
      rank: rankValueField(),
      // The page row's place in its sidebar group: set on every live page row
      // (invariant I-DR), so carried non-null here though its (server-only)
      // column is NULL on content rows.
      docRank: rankValueField(),
    },
  },
  id: "id",
  all: {
    orderBy: [["createdAt", "asc"]],
    unbounded: {
      reason:
        "the sidebar renders every page; the [[ and link pickers filter by title locally",
    },
  },
});

/** A row as `pagesTree` delivers it: the page row plus every exposed field under `$columns`. */
export type PagesTreeRow =
  typeof pagesTree extends LiveRowsCollection<infer R> ? R : never;

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
/**
 * The derived row IS the `PageRow` the HTTP read and the oracle parse
 * (`Required`: zod infers the `z.unknown()` payload as optional, a field
 * never is).
 */
export type _PinPagesTreeRow = Assert<
  Equal<Omit<PagesTreeRow, "$columns">, Required<PageRow>>
>;

// A page's content forest: every block whose nearest page ancestor is
// `pageId`, sub-page rows included — one tuple per page (`all: { by }`), read
// `useLive(pageBlocks, { where: { pageId } })` and, optimistically, by the
// editor's block store. A scoped WHOLE set rather than a window: the editor's
// reducer, its optimistic overlay and document order all need EVERY block of
// the page (a window would truncate the document). Its rows are ordered by
// `(rank, createdAt)` — `rank` is one `(parent_id, rank)` space per parent,
// so the order is only meaningful within siblings, which is how every reader
// uses it (`toNodes` groups by parent) — the id breaking ties.
//
// Served over the `page_blocks` TABLE with the live-block predicate
// (`deleted_at IS NULL`) as its base membership
// (`../server/internal/resources.ts`): a write to one block is a one-row
// refill of ITS page and nothing on any other (the router matches the
// change's `page_id` before loading) — the ~1s `data.text` typing
// projection included, which moves no column the order or the membership
// reads — an insert or a restore an entrant, a trash an exit, a cross-page
// move an exit here and an entrant there.
//
// Its rows are `Block`s, field for field (pinned below): the entity's wire
// fields with `rank` carried as the wire `Rank` and `data` as `unknown` (a
// reader parses a block's payload by its type — `pageData()`, a handle's
// lens — never through the column's record decoder). No exposure folds into
// them (`baseExposures: false`): an extension's fields are the page row's
// (`pagesTree`), not the forest's.
//
// The key is NEW (`page-blocks.v2`; it was the param'd value `page-blocks`):
// a tab still running a bundle that subscribed the old key gets `unknown-key`
// — a `skew` verdict, the Reload prompt. Under the old name it would have
// parsed the sub-ack and then hit a keyed `delta` its non-keyed read cannot
// apply (a thrown "no keyOf registered", the page frozen without a prompt).
// Pinned by `../server/internal/page-blocks-oracle.test.ts`. Not known yet is
// `loading` — there is no `[]` placeholder.
export const pageBlocks = liveCollection("page-blocks.v2", {
  from: pagesEntityRef,
  baseExposures: false,
  carry: {
    pick: [
      "id",
      "pageId",
      "parentId",
      "type",
      "expanded",
      "createdAt",
      "updatedAt",
    ],
    fields: {
      // The wire `Rank` value object over the stored key.
      rank: rankValueField(),
      // The payload as a reader receives it: per block type, parsed by its
      // handle — `BlockSchema.data`'s `unknown`, not the column's record type.
      data: jsonField<unknown>({ schema: z.unknown(), default: {} }),
    },
  },
  id: "id",
  all: {
    by: ["pageId"],
    orderBy: [
      ["rank", "asc"],
      ["createdAt", "asc"],
    ],
    unbounded: {
      reason:
        "one page's content forest — the reducer, the optimistic overlay and document order need every block of the page",
    },
  },
});

/** A row as `pageBlocks` delivers it. */
export type PageBlocksRow =
  typeof pageBlocks extends LiveRowsCollection<infer R> ? R : never;

/** The derived row IS the `Block` every reader of the forest takes. */
export type _PinPageBlocksRow = Assert<Equal<PageBlocksRow, Required<Block>>>;

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
// `pageId` is the nearest page ancestor; NULL for a page-less block at the
// forest root (displayed by no page) — and, for a page row, the page it sits
// under.
export const blockLocations = liveCollection("page.block-locations", {
  from: pagesEntityRef,
  carry: { pick: ["id", "type", "pageId"] },
  id: "id",
});
export const BlockLocationSchema = blockLocations.row;
export type BlockLocation = z.infer<typeof BlockLocationSchema>;

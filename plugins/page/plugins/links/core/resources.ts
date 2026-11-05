import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { stringListField } from "@plugins/fields/plugins/string-list/plugins/config/core";
import { pagesEntityRef } from "@plugins/page/plugins/block-entity/core";
import { BacklinkRowSchema } from "./schemas";

// The pages that link TO `pageId`, ordered by title — one value per target
// page, pushed whole whenever any table its loader read changes (the change
// feed; no explicit notify). A value rather than a collection: its rows are a
// join (`page_links` ⨝ the live `page` blocks, projecting the source page's
// title and icon out of its `data` JSON), not the rows of one table, and the
// edge table's key is the composite (source, target) pair.
export const pageBacklinks = liveValue("page-backlinks", {
  schema: wholeList(BacklinkRowSchema, {
    reason:
      "the pages that link to one page — a join over page_links and the live page blocks, not the rows of one table",
  }),
  params: ["pageId"],
});

// A live page with the pages it links TO (`linksTo`, distinct, a self-link
// excluded, `[]` when it links nowhere), read BY ID — lookup-only, no whole
// set: the pages sidebar reads the rows its tree windows hold (data-view's
// live-tree `aliases`, one `{ ids }` read per loaded level) and draws each
// target as a read-only reference child of the page. So what it holds is
// bounded by the tree's windows, never by how many pages or links exist.
//
// Served over the `page_blocks` TABLE with a MATERIALIZED children join over
// `page_links` on `source_page_id` (`../server/internal/link-target-rows.ts`):
// an edge insert or delete re-aggregates its SOURCE page's stored list, and a
// reader holding that page hears of it only when the list changed; a write to
// a content block — the ~1s `data.text` typing projection — or a rename
// loads nothing; a trashed page reads not found.
//
// The key is NEW (`page-links.targets`; it was `page-links.sources`, the
// whole set of every page with the pages linking TO it, and before it the
// legacy push resource `page-links`): a tab still running a bundle that
// subscribed an old key gets `unknown-key` — a `skew` verdict, the Reload
// prompt. Pinned by `../server/internal/link-targets-oracle.test.ts`.
export const pageLinkTargets = liveCollection("page-links.targets", {
  // A page row (`page_blocks`) with the ids of the pages it links to — an
  // aggregate of the materialized children join, bound by the server half.
  from: pagesEntityRef,
  carry: { pick: ["id"], fields: { linksTo: stringListField() } },
  // Its wire rows stay `{ id, linksTo }`: no exposure of a page folds in.
  baseExposures: false,
  id: "id",
});

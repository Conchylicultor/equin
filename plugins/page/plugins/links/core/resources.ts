import { z } from "zod";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
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
  schema: z.array(BacklinkRowSchema),
  params: ["pageId"],
});

// Every live page with the pages that link TO it (`linkedFrom`, distinct, a
// self-link excluded, `[]` when nothing does), the WHOLE set (`all`): the pages
// sidebar draws each source as a reference parent of the page, over the same
// set of pages `pagesTree` renders. One row per page rather than one per edge,
// so a `page_links` write is the refill of its TARGET page's row alone.
//
// Served over the `page_blocks` TABLE with a children join over `page_links`
// on `target_page_id` (`../server/internal/link-source-rows.ts`): an edge
// insert or delete refills the target's row; a write to a content block — the
// ~1s `data.text` typing projection — loads nothing (the route reads only the
// page row's `id`, `type` and `deleted_at`); a trashed target leaves the set,
// its edges with it.
//
// The key is NEW (`page-links.sources`; it was the legacy push resource
// `page-links`, one row per edge): a tab still running a bundle that
// subscribed the old key gets `unknown-key` — a `skew` verdict, the Reload
// prompt — rather than rows its schema cannot read. Pinned by
// `../server/internal/link-sources-oracle.test.ts`.
//
// Not preloaded: nothing reads it until the Pages sidebar mounts.
export const pageLinkSources = liveCollection("page-links.sources", {
  // A page row (`page_blocks`) with the ids of the pages linking to it — an
  // aggregate of the children join, computed by the server half.
  from: pagesEntityRef,
  carry: { pick: ["id"], fields: { linkedFrom: stringListField() } },
  // Its wire rows stay `{ id, linkedFrom }`: no exposure of a page folds in.
  baseExposures: false,
  id: "id",
  all: {
    orderBy: [["id", "asc"]],
    unbounded: { reason: "one row per live page" },
  },
});

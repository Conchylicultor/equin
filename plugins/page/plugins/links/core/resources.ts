import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import { compositeKey } from "@plugins/network/plugins/live/plugins/query-resource/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import {
  wholeList,
  wholeRecord,
} from "@plugins/packages/plugins/list-bound/core";
import { stringListField } from "@plugins/fields/plugins/string-list/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { z } from "zod";
import { pagesEntityRef } from "@plugins/page/plugins/block-entity/core";
import { BacklinkRowSchema } from "./schemas";

// The pages that link TO `pageId`, ordered by title — one value per target
// page, computed from the rows it FOLLOWS (network/live's `follows`, served in
// `../server/internal/resources.ts`): the target's first edges
// (`pageBacklinkEdges`), the blocks they name, those pages' ancestors and the
// referents of the chips in the linking text — so a write reaches a tuple
// only when it touches a row that tuple read. A value rather than a
// collection: its rows are a join of those, not the rows of one table.
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
// loads nothing; a trashed page reads not found, and a trashed TARGET is left
// out of `linksTo` (the edge itself is kept, so a restore brings it back).
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
  carry: {
    pick: ["id"],
    fields: {
      linksTo: stringListField(),
      linkRanks: jsonField({
        schema: wholeRecord(z.string(), {
          reason:
            "one page's placed links, one rank per page it links to — as many as linksTo",
        }),
      }),
    },
  },
  // Its wire rows stay `{ id, linksTo, linkRanks }`: no exposure of a page folds in.
  baseExposures: false,
  id: "id",
});

// The `page_links` edge table, by reference: its fields, what the server
// builds the table from (`defineEntity`, `../server/internal/tables.ts`) and
// what a collection over it carries. `first`: whether the edge's block is the
// source page's FIRST linking block into that target, in document order.
export const pageLinksEntityRef = entityRef("page_links", {
  sourcePageId: textField(),
  targetPageId: textField(),
  sourceBlockId: textField(),
  first: boolField(),
});

// The FIRST edge of each source page into one target page — a scoped `all`
// set by `targetPageId`, a FOLLOW target of `pageBacklinks` (no surface reads
// it over the wire): per linking page, the block its snippet is read from.
// Served over `page_links` with `first` as the base membership, so an edge
// of a second linking block — and every write to another target's edges —
// reaches no follower; the first block moving is one exit and one entrant.
// Keyed by the table's composite primary key.
export const pageBacklinkEdges = liveCollection("page-links.first-edges", {
  from: pageLinksEntityRef,
  carry: { pick: ["sourcePageId", "targetPageId", "sourceBlockId"] },
  baseExposures: false,
  id: compositeKey(["sourcePageId", "targetPageId", "sourceBlockId"]),
  all: {
    by: ["targetPageId"],
    orderBy: [
      ["sourcePageId", "asc"],
      ["sourceBlockId", "asc"],
    ],
    unbounded: {
      reason:
        "the pages linking to one page, one edge each — as many as link there",
      // Measured on main 2026-11-08: at most 4 linking pages per page (median
      // 1, 20 linked pages); a hub page linked from everywhere is the case
      // the headroom is for.
      budget: 100,
    },
  },
});

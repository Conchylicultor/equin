import { isNull } from "drizzle-orm";
import {
  serveCollection,
  type ServeAllCollectionOptions,
} from "@plugins/network/plugins/live/server";
import type { LookupJoin } from "@plugins/infra/plugins/query-resource/core";
import { _blocks } from "@plugins/page/plugins/editor/server";
import { blockDocs, pageBlockDocs, type PageBlockDocsRow } from "../../core";
import { _pageBlockDocs } from "./tables";

// Server half of the per-block content read: every row field is a column of
// `page_block_docs` by name, and `state` (a `bytea`) reaches the wire through
// the column type's own base64 codec, encoded in JS per row — the same
// `bytesToBase64` the doc-init response uses, so the two wire representations
// are identical by construction. The `:rows` point routing schedules a
// `doc-update` on one block for that block's subscribers only.
export const blockDocsServed = serveCollection(blockDocs, {
  from: _pageBlockDocs,
});

// A block's doc, joined N:1 on the block id — optional (LEFT): a block with no
// doc yet is a row with `state: null`. Its `on` is the host identity, so a
// doc write (`doc-init`'s insert, `doc-update`'s merge) is routed to its own
// block's row alone.
const docJoin = {
  kind: "lookup",
  alias: "doc",
  table: _pageBlockDocs,
  pk: _pageBlockDocs.blockId,
  on: { from: "base", col: _blocks.id },
  required: false,
} satisfies LookupJoin<"doc", typeof _pageBlockDocs>;

// A page's block docs (`pageBlockDocs`, one tuple per page): the live blocks
// of the page — the same membership as `pageBlocks` (`deleted_at IS NULL`,
// scoped by `page_id`, which the change feed carries as a key, so a write on
// one page reaches no other page's tuple) — each with its doc's `state`
// through the bytea column's wire codec, the one `blockDocsServed` uses.
// The options are the ONE spelling the real-DB test (`./doc-store.test.ts`)
// compiles too.
export const pageBlockDocsServeOptions = {
  from: _blocks,
  where: isNull(_blocks.deletedAt),
  joins: [docJoin],
  columns: { state: (j) => j.doc.state },
} satisfies ServeAllCollectionOptions<
  typeof _blocks,
  PageBlockDocsRow,
  readonly [typeof docJoin],
  "pageId"
>;
export const pageBlockDocsServed = serveCollection(
  pageBlockDocs,
  pageBlockDocsServeOptions,
);

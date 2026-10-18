import { serveCollection } from "@plugins/network/plugins/live/server";
import { blockDocs } from "../../core";
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

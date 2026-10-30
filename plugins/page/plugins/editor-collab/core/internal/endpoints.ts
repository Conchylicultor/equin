import { z } from "zod";
import { defineEndpoint, blob } from "@plugins/infra/plugins/endpoints/core";

// First-writer-wins seed for a block's content doc — the ONLY place a
// `page_block_docs` row is created. Body: the proposing client's initial
// `Y.encodeStateAsUpdate(doc)` bytes. The insert is `ON CONFLICT DO NOTHING`,
// so a losing seeder gets back the winner's authoritative state (base64) and
// merges it locally instead of duplicating content — this closes the Yjs
// "two clients independently seed the same text" hazard at the single server
// chokepoint. Idempotent: re-posting after a win returns the stored state.
export const blockDocInit = defineEndpoint({
  route: "POST /api/blocks/:id/doc-init",
  body: blob("application/octet-stream"),
  response: z.object({
    /** The authoritative stored state (winner's), base64. */
    state: z.string(),
  }),
});

// Merge an incremental Yjs update into a block's content doc. The body is raw
// update bytes (`Y.encodeStateAsUpdate(doc, remoteStateVector)` or a Yjs
// `update` event payload). 409 if the doc was never initialized — the server
// NEVER auto-seeds here (that would reopen the duplicate-seed hazard); callers
// must `doc-init` first. Subscribers learn the merged state via
// `blockDocs` (the row UPDATE fires the DB change-feed), so the
// response carries no body.
export const blockDocUpdate = defineEndpoint({
  route: "POST /api/blocks/:id/doc-update",
  body: blob("application/octet-stream"),
});

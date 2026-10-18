import {
  defaultNow,
  defineEntity,
} from "@plugins/infra/plugins/entities/server";
import { _blocks } from "@plugins/page/plugins/editor/server";
import { pageBlockDocsEntityRef } from "../../core";

// One row per text block that has a content CRDT: the compacted
// `Y.encodeStateAsUpdate(doc)` of the block's per-block `Y.Doc` (per-block CRDT
// plan, research/2026-07-07-page-per-block-crdt-plan-b.md — Stage 1).
//
// Content-agnostic by design: the server merges and stores opaque Yjs bytes; it
// never interprets the doc (no runs, no Lexical, no decorator tokens — those
// live in the editor's web runtime, so only a client can build a
// decorator-correct doc). Rows are created exclusively by the first-writer-wins
// `doc-init` endpoint. A user delete is a TRASH (the block row is flagged, not
// deleted), so the doc survives it and an undo binds the restored row back to
// it; the row dies only when the FK cascade finally fires — at purge (30 days,
// or "Delete permanently") and in history restore's content wipe.
//
// Deliberately NOT excluded from the DB change-feed: the `doc-update` UPDATE is
// what pushes the block's `blockDocs` row to its subscribers.
//
// Built from the `page_block_docs` entity ref (core): `state` is a `bytes`
// field, a `bytea` column under a base64 wire value.
//
// `updatedAt` is DERIVED (derived-updated-at): it moves when the merged
// `state` really changes — a doc-update that merges to identical bytes leaves
// it alone.
const pageBlockDocs = defineEntity(pageBlockDocsEntityRef, {
  primaryKey: "blockId",
  columns: {
    blockId: {
      references: { column: () => _blocks.id, onDelete: "cascade" },
    },
    updatedAt: { default: defaultNow() },
  },
  updatedAt: { touchedBy: { state: true, blockId: false } },
});

export const _pageBlockDocs = pageBlockDocs.table;

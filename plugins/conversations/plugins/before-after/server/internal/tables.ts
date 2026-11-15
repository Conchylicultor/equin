import { index, uniqueIndex } from "drizzle-orm/pg-core";
import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import { beforeAfterPairsEntityRef } from "../../core";

// One row per before / after pair a `register_before_after` call registered.
// The fields live in `core/internal/entity.ts` (`beforeAfterPairsEntityRef`).
//
// `id` is an app-minted `ba-…` (no DB default). `conversationId` is a soft
// reference (text, no FK) — the same contract as the append-only
// `conversation_sessions` precedent: a pair is a record of what an agent
// published, and a pane opened by its id from another conversation or a page
// keeps resolving.
//
// Two indexes, each load-bearing:
//   • (conversationId, createdAt) — one conversation's pairs, newest first (the
//     pane's gallery, the Artifacts section).
//   • UNIQUE (toolUseId) — the transcript card's read (the pair its call
//     registered), and the invariant behind it: one call registers one pair.
//     NULLs (a client that named no call) do not collide.
const beforeAfterPairs = defineEntity(beforeAfterPairsEntityRef, {
  primaryKey: "id",
  columns: {
    createdAt: { default: defaultNow() },
  },
  indexes: (t) => [
    index("before_after_pairs_by_conv_idx").on(t.conversationId, t.createdAt),
    uniqueIndex("before_after_pairs_tool_use_idx").on(t.toolUseId),
  ],
});

// drizzle-kit schema-glob discovery.
export const _beforeAfterPairs = beforeAfterPairs.table;

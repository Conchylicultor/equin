# Move queue rank ownership to the queue plugin

## Context

The conversations queue plugin owns Anki-style ordering of `waiting` conversations,
but the underlying rank state lives on the core `_conversations` table in
`tasks-core`, and the cycling rule that reassigns rank on every turn lives in
`tasks-core.updateConversation`. This is a layering violation —
`tasks-core` self-describes as "schema + repository layer" yet carries
queue-specific behavior — and it produces a real bug: when a `gone`
conversation is recovered, the poller drives `gone → working → waiting`, which
fires the status-transition cycling rule and clobbers the conversation's
original deck position.

The fix is structural: own queue rank end-to-end in the queue plugin via the
`entity-extensions` primitive (same precedent as
`agents/auto-launch/toggle`), and trigger cycling from
`conversationTurnCompleted` instead of status transitions. After this, recover
no longer touches rank by construction — only real assistant turns do — and
`tasks-core` becomes truly queue-agnostic.

No data migration: existing rank values can be discarded.

## Target shape

### New side-table — `_conversations_ext_queue`

`plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/tables.ts` (new file):

```ts
import { rankText } from "@server/db/types";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { _conversations } from "@plugins/tasks-core/server";

export const _conversationsExtQueue = defineExtension(_conversations, "queue", {
  rank: rankText("rank").notNull(),
});
```

drizzle-kit's schema glob (`server/drizzle.config.ts:26-31`) picks this up
automatically. FK CASCADE on `_conversations.id` is provided by
`defineExtension`.

### Rank logic — moves into the queue plugin

`plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/queue-ranks.ts` (existing, rewritten):

- Add `endRank()` and `positionTwoRank()` (moved from
  `plugins/tasks-core/server/internal/mutations/conversations.ts:36-63`).
- Rewrite the existing 7 read sites
  (`rankForTop`, `rankForBottom`, `rankAfterN`, `rankAdjacentTo`) to
  query `_conversationsExtQueue` joined with `_conversations` on
  `conversationId`, filtering on `_conversations.status = 'waiting'`. The
  shape and semantics of every helper stay identical.

### Triggers — cycling fires on real turn events

`plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/seed-rank-job.ts` (new):

A single `defineJob` job that takes `event.conversationId`, calls
`positionTwoRank()`, and `upsertExtension(_conversationsExtQueue, id, { rank })`.
Notifies `queueRanksResource` after the write.

User confirmed: both creation and turn-completion seed at position 2 (just
below current top). One job, two triggers.

`plugins/conversations/plugins/conversations-view/plugins/queue/server/index.ts`:

- Add `register: [seedRankJob]`.
- In `onReady`, mirror the canonical pattern from `improve` and
  `conversation-progress`:

```ts
await deleteTriggersFor(seedRankJob);
await trigger({ on: conversationCreated,        do: seedRankJob, with: {}, oneShot: false });
await trigger({ on: conversationTurnCompleted,  do: seedRankJob, with: {}, oneShot: false });
```

### Reorder routes — write the ext table directly

`handle-{reorder,promote,demote,step-down}.ts` currently call
`updateConversation(id, { rank })`. Change them to
`upsertExtension(_conversationsExtQueue, id, { rank })` followed by
`queueRanksResource.notify()`. No more rank-going-through-tasks-core.

### Resource — queue exposes its own ranks channel

`plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/resource.ts` (new):

```ts
export const queueRanksResource = resourceDescriptor<Array<{ conversationId: string; rank: string }>>({
  key: "queue-ranks",
  origin: "push",
  load: async () => db.select({ conversationId: _conversationsExtQueue.parentId, rank: _conversationsExtQueue.rank }).from(_conversationsExtQueue),
});
```

Register it in `server/index.ts`. The view subscribes to it alongside
the existing conversations resource and joins client-side.

### Client — queue view reads rank from the new resource

`plugins/conversations/plugins/conversations-view/plugins/queue/web/components/queue-view.tsx`:

- `const ranks = useResource(queueRanksResource)` → build a
  `Map<conversationId, rank>`.
- Filter conversations on `status === "waiting"` AND `ranks.has(c.id)`,
  sort by the looked-up rank.

The `Conversation.rank` field on the client is no longer used.

### tasks-core deletions

`plugins/tasks-core/server/internal/tables.ts`:
- Remove `rank` column (line 129) and the `conversations_status_rank_idx` (line 134).

`plugins/tasks-core/server/internal/schema.ts`:
- Remove `rank: z.string().nullable()` from `ConversationSchema` (line 230).

`plugins/tasks-core/server/internal/mutations/conversations.ts`:
- Delete `endRank` and `positionTwoRank` helpers (lines 36-63).
- Remove `rank?: string` from `InsertConversationInput` and `UpdateConversationPatch`.
- Remove the rank assignment from both insert paths (lines 90, 100, 116, 128).
- Remove the cycling branch in `updateConversation` (lines 156-165) and the
  `if (patch.rank !== undefined) dbPatch.rank = patch.rank` pass-through (line 147).

### Auto-generated migration

`./equin build` will diff schema, producing a single migration that
creates `conversations_ext_queue` and drops the `rank` column + index from
`_conversations`. No manual migration writing; no backfill SQL.

### Delete the old backfill

`backfill-ranks.ts` and the `onReady: backfillRanks` line in the queue plugin's
`server/index.ts` go away. With no rank column on `_conversations`, the legacy
backfill has no purpose, and the user explicitly confirmed data loss is
acceptable.

## Critical files

| Action | File |
|---|---|
| Create | `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/tables.ts` |
| Create | `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/seed-rank-job.ts` |
| Create | `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/resource.ts` |
| Rewrite | `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/queue-ranks.ts` |
| Rewrite | `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/handle-reorder.ts` |
| Rewrite | `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/handle-promote.ts` |
| Rewrite | `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/handle-demote.ts` |
| Rewrite | `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/handle-step-down.ts` |
| Rewrite | `plugins/conversations/plugins/conversations-view/plugins/queue/server/index.ts` |
| Rewrite | `plugins/conversations/plugins/conversations-view/plugins/queue/web/components/queue-view.tsx` |
| Delete | `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/backfill-ranks.ts` |
| Edit | `plugins/tasks-core/server/internal/tables.ts` |
| Edit | `plugins/tasks-core/server/internal/schema.ts` |
| Edit | `plugins/tasks-core/server/internal/mutations/conversations.ts` |
| Add dep | `plugins/conversations/plugins/conversations-view/plugins/queue/package.json` (entity-extensions) |

## Implementation order

1. Add the entity-extensions dep to the queue plugin's `package.json`; `bun install`.
2. Add `_conversationsExtQueue` table file. Add the resource. Run `./equin build` once to confirm migration generates and applies cleanly.
3. Move `endRank` / `positionTwoRank` into `queue-ranks.ts`; rewrite all queue-ranks helpers to read from the ext table. Type-check.
4. Add `seedRankJob` and the two `trigger()` calls in the queue plugin's `onReady`.
5. Rewrite the four reorder route handlers to write the ext table directly.
6. Update `queue-view.tsx` to read from `queueRanksResource`.
7. Strip rank from `tasks-core` (column, schema, helpers, cycling branch, insert/patch types). Run `./equin build` — migration drops the column. Confirm app boots clean.
8. Delete `backfill-ranks.ts` and its `onReady` registration.
9. `./equin check` to make sure plugin boundaries and eslint stay green.

Each step compiles independently, so type errors surface incrementally.

## Verification

End-to-end checks after `./equin build`:

1. **Recover preserves rank** (the original bug). Send a `waiting` conversation
   to position N via the queue UI (`http://<worktree>.localhost:9000` →
   Conversations → Queue, drag to position N). Close it from the conversation
   toolbar. Restore it from the Recovery sidebar. After it idles back to
   `waiting`, it should still be at position N — not position 2.
2. **Turn cycling still works.** Send any `waiting` conversation a turn via
   the prompt input. After the assistant finishes, the conversation should
   move to position 2 (one slot below the current top).
3. **New conversations appear at position 2.** Spawn a fresh conversation
   from the welcome pane / launch button. Once it transitions to `waiting`,
   it should land at position 2 of the queue.
4. **Manual reorder still works.** Drag, promote (top), demote (bottom), and
   step-down (Anki-style) buttons in the queue view all produce the expected
   movements.
5. **`./equin check`** passes (plugin boundaries + eslint).
6. **DB sanity:** `psql … -c "\d conversations_ext_queue"` shows the new
   table with FK CASCADE; `\d conversations` no longer shows `rank`.

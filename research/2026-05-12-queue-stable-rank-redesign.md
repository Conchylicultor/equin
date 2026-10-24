# Queue Stable-Rank Redesign

## Context

The queue plugin (`plugins/conversations/plugins/conversations-view/plugins/queue/`) uses an "Anki-style" algorithm where every conversation is re-ranked to position 2 on `conversationCreated` and `conversationTurnCompleted`. This causes the queue order to shuffle on every agent turn completion, making it unstable. The redesign introduces a **stable-rank model** with a **pinned top** concept for predictable queue behavior.

## Design

### Core principles

1. **Rank is stable.** Seeded once on creation (newest first = top rank). Never re-ranked automatically.
2. **Pinned top.** A single conversation ID persisted in DB — the user's current focus/review item. Never displaced by new conversations. Released only when the conversation becomes active.
3. **Manual reorder preserved.** DnD, promote, demote, step-down all still work and override the seed rank.

### Pin lifecycle

- **Set:** When a conversation becomes `waiting` (agent finished) and no pin exists → pin the top-ranked waiting conversation.
- **Held:** New conversations don't displace the pin. They get top rank but start as `starting`/`working`, not `waiting`.
- **Released:** When the user sends a turn to the pinned conversation (`userTurnSent`) → advance to next waiting by rank.
- **Override:** `promote` explicitly sets the pin to the promoted conversation.
- **Defensive:** `validatePin()` runs on every resource load and after every mutation — catches gone/done/deleted pins.

### Triggers

| Event | Job | What it does |
|---|---|---|
| `conversationCreated` | `seedRankJob` | Seed rank at top (idempotent). Call `validatePin()`. |
| `conversationTurnCompleted` | `validatePinJob` | Call `validatePin()` — if no pin, set one. |
| `userTurnSent` | `advancePinJob` | If this is the pinned conversation, advance to next. |

## Changes

### 1. Schema: add `queue_state` table

**`server/internal/tables.ts`** — Add standalone pgTable (not entity-extension — this is singleton state):

```ts
export const _queueState = pgTable("queue_state", {
  id: text("id").primaryKey(),
  pinnedConversationId: text("pinned_conversation_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

### 2. Pin management — new `server/internal/pinned.ts`

Four functions:

- `getPinnedId(executor?)` — read from `queue_state` singleton row
- `setPinnedId(id | null, executor?)` — upsert `queue_state` singleton
- `topWaitingByRank(excludeId?, executor?)` — first waiting conversation by rank (joins ext-queue + conversations, filters `status = "waiting"`, orders rank ASC, limit 1)
- `validatePin(executor?)` — if current pin is valid (exists, waiting, has rank) → keep it; else → `topWaitingByRank()` and persist

### 3. Seed job — simplify

**`server/internal/seed-rank-job.ts`**:
- Remove blocker-aware logic (`hasBlockingDep`, `listBlockingDepIds`, `rankAfterBlockers`)
- Remove `isTopOfDeck` check
- Add idempotency: skip if conversation already has a rank
- Seed at `rankForTop(conversationId, tx)` inside `lockDeck` transaction
- Call `validatePin()` after transaction

### 4. New jobs

**`server/internal/validate-pin-job.ts`** — Calls `validatePin()` + notifies. Triggered by `conversationTurnCompleted`.

**`server/internal/advance-pin-job.ts`** — If `event.conversationId === getPinnedId()`, set pin to `topWaitingByRank(event.conversationId)` + notify. Triggered by `userTurnSent`.

### 5. Handler updates

| Handler | Change |
|---|---|
| `handle-promote.ts` | Add `setPinnedId(conversationId)` after rank change |
| `handle-demote.ts` | Add `validatePin()` after rank change |
| `handle-step-down.ts` | Add `validatePin()` after rank change |
| `handle-reorder.ts` | Add `validatePin()` after rank change |
| `handle-rerank.ts` | Replace `positionTwoRank`/`rankAfterBlockers` with `rankForTop()`. Add `validatePin()`. |

### 6. `queue-ranks.ts` cleanup

- **Add executor param** to `rankForTop(excludeId, executor = db)` — needed inside `lockDeck` transactions
- **Remove** `positionTwoRank` (no more position-2 seeding)
- **Remove** `isTopOfDeck` (pin is explicit, not derived)
- Keep everything else: `lockDeck`, `rankForTop`, `rankForBottom`, `rankAfterN`, `rankAdjacentTo`, `rankAfterBlockers`, `endRank`

### 7. Resource shape change

**`shared/resources.ts`** — Change payload from `QueueRankRow[]` to `{ ranks: QueueRankRow[], pinnedConversationId: string | null }`:

```ts
export const QueueDataSchema = z.object({
  ranks: z.array(QueueRankRowSchema),
  pinnedConversationId: z.string().nullable(),
});
```

Keep resource key `"queue-ranks"`. Push-mode resource — no client persistence, shape change is safe.

**`server/internal/resource.ts`** — Loader returns `{ ranks, pinnedConversationId: await validatePin() }`.

### 8. `server/index.ts` wiring

```ts
contributions: [
  Resource.Declare(queueRanksResource),
  Trigger({ on: conversationCreated, do: seedRankJob, with: {}, oneShot: false }),
  Trigger({ on: conversationTurnCompleted, do: validatePinJob, with: {}, oneShot: false }),
  Trigger({ on: userTurnSent, do: advancePinJob, with: {}, oneShot: false }),
],
register: [seedRankJob, validatePinJob, advancePinJob],
```

Remove `positionTwoRank` and `isTopOfDeck` from exports.

### 9. Web changes

**`web/components/queue-view.tsx`**:
- `useResource(queueRanksResource)` returns `{ ranks, pinnedConversationId }`
- Top item determined by `pinnedConversationId`, not by position in sorted deck
- Pinned item renders with sticky card styling; rest of deck excludes pinned item

### 10. Note on `blocked-by`/`blocking` plugins

These call `POST /api/conversations-queue/rerank` after adding/removing dependencies. Under the new model, `/rerank` uses `rankForTop()` — the conversation gets top rank. This is fine because blocked conversations are already visually separated client-side by task status.

## File summary

| File | Action |
|---|---|
| `server/internal/tables.ts` | Add `_queueState` pgTable |
| `server/internal/pinned.ts` | **NEW** — pin management |
| `server/internal/validate-pin-job.ts` | **NEW** — triggered by `conversationTurnCompleted` |
| `server/internal/advance-pin-job.ts` | **NEW** — triggered by `userTurnSent` |
| `server/internal/seed-rank-job.ts` | Simplify: top rank, idempotent, validate pin |
| `server/internal/queue-ranks.ts` | Add executor to `rankForTop`, remove `positionTwoRank`/`isTopOfDeck` |
| `server/internal/resource.ts` | Return `{ ranks, pinnedConversationId }` |
| `server/internal/handle-promote.ts` | Add `setPinnedId` |
| `server/internal/handle-demote.ts` | Add `validatePin` |
| `server/internal/handle-step-down.ts` | Add `validatePin` |
| `server/internal/handle-reorder.ts` | Add `validatePin` |
| `server/internal/handle-rerank.ts` | Simplify to `rankForTop` + `validatePin` |
| `server/index.ts` | Update triggers, exports, register |
| `shared/resources.ts` | Change schema to `{ ranks, pinnedConversationId }` |
| `web/components/queue-view.tsx` | Use `pinnedConversationId` for top-item |

## Verification

1. `./equin build` — generates migration for `queue_state`, builds everything
2. Create conversation → gets top rank, no pin yet (starting/working)
3. Agent finishes → conversation becomes waiting → `validatePinJob` fires → becomes pinned
4. Create second conversation → seeds at top rank, pin unchanged
5. Send turn to pinned conversation → pin advances to next waiting
6. Promote non-pinned → becomes new pin
7. Demote pinned → pin advances
8. DnD reorder → pin stays stable
9. `blocked-by`/`blocking` plugins still work (call `/rerank`)
10. Screenshot queue UI

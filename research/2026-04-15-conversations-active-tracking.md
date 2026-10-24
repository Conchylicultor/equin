# Track Active Conversations + Fix Homepage Count

## Context

The homepage displays an "active conversations" count computed from the live SSE map (`live[id].working`), which is wrong: it reports only conversations currently being *processed by Claude*, not conversations that are still alive. We want "active" to mean **not in a terminal state** so we can:

1. Show a correct active count on the homepage.
2. Later, build a historical "active over time" chart in the `stats` plugin using stored timestamps.

Today's state model also has a latent bug: `completed` is set by the poller whenever the tmux process exits (`dead: true`), so it behaves like a second flavor of `gone`. `completed` and `obsolete` were meant to be reserved values. We'll repurpose them per the target model below.

## Target state model

Statuses (after rename):

| Status | Meaning | Active? |
|---|---|---|
| `starting` | DB row exists, runtime not yet reporting | yes |
| `working` | Claude actively processing | yes |
| `needs_attention` | Runtime idle, waiting for user | yes |
| `completed` | Conversation ended **and** at least one push exists for it | no |
| `gone` | Runtime entry vanished without warning — we don't know why. Potential bug signal. | no |
| `abandoned` | Explicitly exited by user (renamed from `obsolete`). | no |

**`active` is derived**, not stored as its own enum or column — see "Zod sibling field" below.

### Transitions

- `starting → working | needs_attention` — from runtime state (unchanged).
- `working ↔ needs_attention` — from runtime `working` flag (unchanged).
- any-live → **`completed`** — runtime reports `dead: true` AND a `pushes` row exists for this conversation.
- any-live → **`gone`** — runtime reports `dead: true` with no push row, OR runtime entry vanishes entirely (tmux pane closed unexpectedly).
- any-live → **`abandoned`** — user explicitly exits (future UI action; not implemented in this change).

Completed conversations never pass through `gone`. The `dead` event is the decision point: push history determines `completed` vs `gone`.

## Zod sibling field

Keep `status` as today (single string column). Derive a sibling `active: boolean` on the zod select schema so clients can use `conv.active` without importing a helper. Existing `conv.status === "working"` comparisons keep working.

```ts
const TERMINAL_STATUSES = ["completed", "gone", "abandoned"] as const;
const isActiveStatus = (s: ConversationStatus) => !TERMINAL_STATUSES.includes(s);

export const ConversationSchema = createSelectSchema(conversations, {
  status: ConversationStatusSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  endedAt: z.coerce.date().nullable(),
}).transform((row) => ({ ...row, active: isActiveStatus(row.status) }));
```

`isActiveStatus` and `TERMINAL_STATUSES` live in `plugins/conversations/shared/types.ts` so the poller and any server-side filters import the same source of truth.

## Timestamps

Add one nullable column: **`endedAt: timestamp`** on `conversations`.

- Set whenever status transitions into `completed` / `gone` / `abandoned`.
- Combined with `createdAt`, enough to reconstruct active-count at any past time:
  `COUNT(* WHERE createdAt <= T AND (endedAt IS NULL OR endedAt > T))`.

(Single column rather than per-status: the existing `status` already records *how* it ended; we only need *when*. An audit/transitions table can come later if reason-over-time becomes a required stat.)

## Implementation steps

### 1. Schema & migration
`plugins/conversations/server/schema.ts`:
- Rename enum value `obsolete` → `abandoned` in `ConversationStatusSchema`.
- Add `endedAt: timestamp("ended_at", { withTimezone: true })` (nullable).
- Extend `ConversationSchema` with the `.transform()` that adds the `active` sibling field (see above).
- Export `TERMINAL_STATUSES` and `isActiveStatus` from `plugins/conversations/shared/types.ts`.
- Migration regenerated via `./equin build`. Backfill any existing rows with `status = 'obsolete'` to `'abandoned'` in the generated migration (there likely are none today).

### 2. Poller rework
`plugins/conversations/server/internal/poller.ts`:
- Drop the `if (info.dead) return "completed"` branch from `statusFor()`. Live updates only produce `working` / `needs_attention`.
- New terminal decision path, applied when `info.dead === true` **or** the id vanishes from the runtime map:
  - Query `pushes` for that conversation id (single `exists` check).
  - If a push row exists → set `status = "completed"`, `endedAt = now()`.
  - Else → set `status = "gone"`, `endedAt = now()`.
- Skip rows already in any terminal status (`completed`, `gone`, `abandoned`) in the dead/vanished sweeps.
- Broadcast `status` SSE on change (existing mechanism).

### 3. Homepage fix
`plugins/welcome/web/components/welcome-view.tsx:86-87`:
- `const activeCount = conversations.filter((c) => c.active).length;`
- Remove the `live[id].working`-based count. Per-row "working" indicator elsewhere can still consult `live` independently.

### 4. Out of scope (done by other agents)
- **Writing `pushes` rows**: another agent will wire `./equin push` (or a server-side watcher) to insert into the `pushes` table. This plan only *reads* from it.
- Historical active chart in `stats` plugin (schema will be ready).
- UI to explicitly `abandon` a conversation.

## Verification

- `./equin build` → homepage active count matches `status IN (starting, working, needs_attention)`.
- Kill a tmux pane for a conversation with no pushes → SSE emits `status: gone`; DB row: `status = gone`, `ended_at` set; homepage count decrements.
- Insert a fake `pushes` row for a live conversation, then kill its pane → status lands on `completed` (not `gone`), `ended_at` set.
- DB sanity: `select status, ended_at, created_at from conversations order by created_at desc;` — every non-active row has `ended_at`.

## Files touched

- `plugins/conversations/server/schema.ts` — rename enum value, add `endedAt`, transform `active` sibling.
- `plugins/conversations/shared/types.ts` — `TERMINAL_STATUSES`, `isActiveStatus`.
- `plugins/conversations/server/internal/poller.ts` — terminal decision (push lookup), endedAt writes.
- `plugins/welcome/web/components/welcome-view.tsx` — use `c.active`.
- Any `"obsolete"` literal references (badge styling, filters) → `"abandoned"`. Expected sites: `plugins/conversations/plugins/conversation-view/plugins/status/web/components/status-badge.tsx` and poller skip-list.

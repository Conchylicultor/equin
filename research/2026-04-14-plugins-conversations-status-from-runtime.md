# Drive `conversation.status` from runtime state

## Context

`conversations.status` exists in the DB with enum `starting | working | needs_attention | completed | obsolete` (`plugins/conversations/server/schema.ts:5-23`), is rendered by the status-badge plugin (`plugins/conversations/plugins/conversation-view/plugins/status/web/components/status-badge.tsx`), and is returned by both `GET /api/conversations` and `GET /api/conversations/:id`. But the column is hard-coded to its default `"starting"` at insert and **never transitions**. Open item #2 in [the runtime-abstraction todo](./2026-04-14-plugins-conversations-runtime-abstraction-todo.md) calls for wiring this up.

The poller (`plugins/conversations/server/internal/poller.ts`) already owns the equivalent logic for `title` and `claudeSessionId`: tick → diff live snapshot vs. DB → UPDATE + SSE broadcast. Status persistence slots into the same loop — no new infrastructure.

`claudeSessionId` DB persistence is already wired (verified): column exists (migration `20260414_050317`), poller updates it in `poller.ts:95-115`, SSE emits `claude-session` events, handlers return the column via `select()`. Nothing to add there.

## State mapping (per user)

While a runtime session is **alive**:

| `RuntimeInfo.idle` | → status       |
| ------------------ | -------------- |
| `false` (working)  | `working`      |
| `true`  (waiting)  | `needs_attention` |

`starting` persists only from INSERT until the first poller tick observes the session. On `gone` (session disappears from `Runtime.list()`): **status is not changed** — the last live status sticks. `completed` and `obsolete` are unused by this pass (reserved for future worktree-merge / stale detection).

Note: the word "idle" is overloaded in the current frontend (appears to label "tmux session closed" in some UI copy). That terminology cleanup is **out of scope** here — this change only touches the DB column and the SSE status event; the frontend status-badge already consumes `conversation.status` directly.

## Design

### 1. Derive status in the poller tick

`plugins/conversations/server/internal/poller.ts` — extend the existing diff loop (lines 95-115) that currently handles `title` and `claudeSessionId`.

For every live entry in `next`:

```ts
const desiredStatus: ConversationStatus = info.idle ? "needs_attention" : "working";
const statusChanged = desiredStatus !== dbRow.status;
```

Fold `statusChanged` into the same `patch` object and the same `UPDATE` — one write per conversation per tick. Broadcast a new SSE `status` event (see §3) when it changes.

Rationale for staying inside the existing loop: we already compute `next` and read `dbById`; adding a third diffed field is a one-line addition, not a new pipeline.

### 2. Keep `starting` strictly as "pre-first-tick"

Lifecycle already inserts with default `"starting"` (`plugins/conversations/server/internal/lifecycle.ts:15-35`) — no change. The first poller tick that sees the new session (either via the normal alive branch or the orphan-adopt branch at `poller.ts:57-82`) will transition it to `working` or `needs_attention`. No explicit "first-tick" flag needed — the diff against the DB row handles it.

Orphan-adopt branch: today it inserts the row with schema defaults (status = `"starting"`). Set `status` at insert time from `info.idle` in that branch too, so adopted orphans don't spend a tick in `"starting"`.

### 3. SSE `status` event

`plugins/conversations/shared/protocol.ts` — extend the event union:

```ts
| { type: "status"; id: string; status: ConversationStatus }
```

Broadcast from the poller alongside the existing `title` / `claude-session` events when status flips. The client stream handler updates the corresponding conversation's `status` in state; the status-badge plugin re-renders because it reads `conversation.status` from the list state (`status-badge.tsx:13-26`).

Full-refresh path still works: on SSE reconnect, the frontend refetches `GET /api/conversations`, which now returns the live status from the DB.

### 4. Delete / gone — no status change

`gone` handling in `poller.ts` leaves the DB row untouched (already the case for title/claudeSessionId — they aren't cleared on gone either). Extend nothing. `handleDelete` continues to hard-delete the row and broadcast `deleted`.

## Critical files

- **Modify** `plugins/conversations/server/internal/poller.ts` — add `status` to the DB read projection, to the diff (live branch + orphan-adopt branch), to the `patch`, and emit the new SSE event.
- **Modify** `plugins/conversations/shared/protocol.ts` — add `status` event variant.
- **Modify** the frontend SSE consumer (`plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx` and any parallel `welcome-view` / `stream/client` consumer) — handle `status` event by patching the conversation's `status` in list state.

No new files. No migration.

## Verification

1. `./equin build` — server restarts, no migration drift.
2. SQL: `SELECT id, status FROM conversations;` — existing live rows transition from `starting` to `working` or `needs_attention` within ~1s of server restart.
3. In a tmux session, type `printf '\033]2;doing stuff\007'` → within 1s: `status = working`, badge turns blue. Clear the title (`printf '\033]2;\007'`) → `status = needs_attention`, badge turns amber.
4. `curl -N http://<worktree>.localhost:9000/api/conversations/stream` — observe `data: {"type":"status","id":"claude-...","status":"working"}` frames on the transitions above.
5. `tmux kill-session -t claude-...` — `gone` event fires, status **does not change** (verify via `SELECT status FROM conversations WHERE id = 'claude-...'`).
6. Create a new conversation from the UI — row briefly shows `starting`, then within one tick transitions to the appropriate live status.
7. Delete a conversation from the UI — row is removed (no `obsolete` transition, per scope).

## Out of scope / follow-ups

- `completed` and `obsolete` semantics (worktree-merge detection, stale-row cleanup).
- "Idle" terminology cleanup in frontend copy (tmux-gone vs. claude-waiting).
- Surfacing `claudeSessionId` in the UI (todo item #1 — separate plan).

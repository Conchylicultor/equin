# Scope the infra `conversations_v` scan to non-terminal rows

## Context

The runtime profiler flagged `select … from conversations_v … order by created_at desc`
executing ~78× during an app session (~1.4s cumulative, max ~100ms each, spiking to
multi-second under contention). It was reported as a per-page-load N+1 driving perceived
interactive slowness.

**Investigation reframes the problem.** That exact query — the one with **no `WHERE`
clause** — is `listConversationsForInfra()`. In the live profiler its `byParent` is **empty**
(`[]`), meaning it runs with no enclosing HTTP/loader span: it is fired by **background
timers**, not page loads. Its two and only callers are:

- `plugins/conversations/server/internal/poller.ts:80` — the conversation poller, `setInterval` every **1000ms** (1 Hz).
- `plugins/conversations/server/internal/turn-emitter.ts:39` — the turn emitter, `setInterval` every **5000ms**.

So "78× per load" is really ~78 timer ticks over the ~78s profiling window — it fires at a
fixed rate forever, independent of page loads.

**The real defect is unbounded row growth.** `listConversationsForInfra()` returns *every*
conversation row, joined through `conversations_v` (conversations ⋈ attempts), ordered, with
no limit. On main today:

```
total conversations: 2203   (2147 'done', growing forever)
non-terminal (working/waiting/starting): 31
```

The poller and turn-emitter only ever act on non-`done` rows, yet the query drags **2203 rows
through a join + sort + serialization + Drizzle row-mapping every second** — ~98.6% of which
are immediately discarded. This scales linearly with all-time history, so it gets steadily
worse and explains the multi-second spikes under DB contention.

Intended outcome: bound this recurring query to the handful of rows the callers actually use,
turning an O(all-history) scan into an O(active) one with zero behavior change.

## Root cause

`listConversationsForInfra()` (`plugins/tasks-core/server/internal/queries/conversations.ts:55`)
passes only `{ includeSystem: true }` — no status filter — so `buildWhere` produces no status
predicate and the query returns the full table.

Both callers already discard terminal rows:
- Poller skips `done` (`poller.ts:139`) and `gone`/`done` (`poller.ts:216`) in both its reconciliation loop and its mark-gone sweep.
- Turn-emitter keeps only `isActiveStatus(c.status)` (`turn-emitter.ts:49`), and `isActiveStatus` = `status !== "done"` (`plugins/conversations/server/status.ts:4`).

## Fix (surgical, one line)

The `conversations_v` view already exposes an `active` boolean column defined as
`status <> 'done'` (`plugins/tasks-core/server/internal/schema.ts:156`), and the `Filters` type
already supports `active?: boolean` → `eq(conversations.active, …)`
(`queries/conversations.ts:30`). So the fix reuses existing primitives:

```ts
// plugins/tasks-core/server/internal/queries/conversations.ts
export function listConversationsForInfra(): Promise<Conversation[]> {
  return queryConversations(
    { includeSystem: true, active: true }, // ← add active:true → WHERE active (status <> 'done')
    { col: conversations.createdAt, dir: "desc" },
  );
}
```

This narrows the query to `WHERE active = true` (i.e. `status <> 'done'`), including system
kinds. Result set drops from ~2203 to ~31 rows.

### Why this is behavior-preserving

- **`active = status <> 'done'` is exactly `isActiveStatus`.** It keeps `working/waiting/starting`
  **and `gone`** rows; it drops only `done`.
- **Turn-emitter:** identical output — it already filters `!isActiveStatus` (drops `done`) in JS.
- **Poller reconciliation:** `done` rows were always `continue`d; never excluding anything used.
- **Poller mark-gone sweep:** acts only on non-`done`/non-`gone` rows missing from the live set;
  those are all retained. `gone` rows are kept, so the **resurrection path** (`poller.ts:175`,
  `dbRow.status === "gone"`) still works.
- **Orphan adoption** (main-only): if a lingering live session ever maps to a now-excluded
  `done` row, `adoptOrphanConversation` is `.onConflictDoNothing()`-guarded on the conversation
  id (`mutations/cross-table.ts:61,89`), so re-adoption is a no-op. In practice `done` = a
  deliberate close that kills the tmux session, so this case effectively never arises.

### Notes / optional follow-ups (not required)

- The `ORDER BY created_at DESC` is unused by both callers (they build a `Map`/`Set`). On ~31
  rows it is negligible; leaving it keeps the diff to one line. Drop later if desired.
- There is **no index on `conversations.status`** (`plugins/tasks-core/server/internal/tables.ts`).
  A partial index `WHERE status <> 'done'` would make this a near-instant index scan, but the
  row-count reduction is the dominant win — defer unless profiling still shows cost.
- **Separate, larger issue (out of scope):** every `notifyConversationsChanged()` fans out
  through `conversationsLiveResource`'s `dependsOn` graph, reloading ~15 downstream resources
  (the profiler shows `reorder.*` loaders at 318 calls, `tasks`/`attempts`/`agent-launches`
  each full-table reads). That cascade amplification is the bigger driver of churn during
  active agent work and deserves its own investigation.

## Files

- **Edit:** `plugins/tasks-core/server/internal/queries/conversations.ts` (`listConversationsForInfra`, line ~55).

No schema change, no migration, no new query primitive.

## Verification

1. `./equin build` from the worktree.
2. Reset and re-measure the profiler window:
   - `POST /api/debug/profiling/runtime/reset` (or the Debug → Profiling → Runtime "reset"), let it idle ~60s.
   - `get_runtime_profile` MCP tool, `kind: "db"`. The `from conversations_v order by created_at desc`
     aggregate should still appear (~60 poller ticks/min) but with **avgMs/maxMs sharply lower**
     and far less cumulative time; `byParent` stays `[]` (still timer-driven).
3. Confirm row count via `query_db`:
   `SELECT count(*) FROM conversations_v WHERE active` → ~31 vs `SELECT count(*) FROM conversations_v` → ~2203.
4. Functional smoke test (poller correctness):
   - Open a conversation, confirm it shows `working`/`waiting` (poller still reconciles live sessions).
   - Exit a conversation → it transitions to `done`/`gone` and disappears from active lists.
   - Resume a `gone` conversation → it resurrects to `working` (validates the kept-`gone` behavior).
   - Confirm turn-summary / turn-completed events still fire on an active conversation (turn-emitter still subscribes).

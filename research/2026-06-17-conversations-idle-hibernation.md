# Idle conversation hibernation (transparent suspend & restore)

## Context

Today every Claude conversation is backed by a live `tmux` session (session name = conversation id, 1:1). Those sessions are kept alive indefinitely and consume host resources (a `claude` process + pane per conversation), even for conversations nobody has looked at in days. Two pain points follow:

1. **No resource reclaim.** A waiting conversation idles forever holding a process.
2. **Reboots are destructive.** `tmux` is in-memory, so a machine restart kills every session. The poller then marks all of them `gone` ("Disconnected" in the UI), forcing manual recovery via the Recovery pane.

We want a **global policy** where an **idle (`waiting`) conversation** whose process has been gone — either proactively killed after an idle timeout (default 48h) **or** lost to a reboot — keeps showing as a normal **waiting** conversation, and is **silently resumed** (`claude --resume`) the moment the user opens it. The user never learns the process was killed. Working/starting conversations are out of scope (killing them loses an in-flight turn and "working with no process" would be a lie) — they keep today's `gone` behavior.

The conversation view renders the transcript **from disk** (`jsonl-viewer`), independent of the live process, so a background resume is naturally invisible: the user sees the full conversation immediately; by the time they type, the process is back.

## Design

Introduce a **hibernation** state that is **orthogonal to `status`** (status stays `waiting`, satisfying "still displayed as a waiting conversation").

### New conversation lifecycle fields (base table)

In `plugins/tasks/plugins/tasks-core/server/internal/tables.ts` (`_conversations`), add two nullable `timestamp with time zone` columns — these are lifecycle fields like `status`/`claudeSessionId`/`closeRequested`, so they live on the base row (the poller already reads it via `listConversationsForInfra`), not a side-table:

- **`hibernatedAt`** — set when the process is intentionally absent (hibernated). `null` = process expected alive. Status is untouched.
- **`lastViewedAt`** — updated when the user opens the conversation (and on every turn sent). Drives the idle timer. Falls back to `createdAt` when null.

Wire through `schema.ts` (`ConversationSchema`) and add repo helpers in tasks-core:
- `setConversationHibernated(id, date | null)`
- `touchConversationViewed(id)` (sets `lastViewedAt = now()`)
- `listHibernationCandidates(before: Date)` — rows where `status = 'waiting' AND hibernatedAt IS NULL AND claudeSessionId IS NOT NULL AND coalesce(lastViewedAt, createdAt) < before`
- include `hibernatedAt` in the `listConversationsForInfra` projection.

### Config (global policy)

Define `hibernationConfig` in **`plugins/conversations/core`** (a leaf — importable by both the parent poller and the child hibernation sub-plugin without forming a cycle):

```ts
{ enabled: boolean = true, idleHours: number = 48 }
```

Registered as a `config_v2` config (editable from the Config settings pane) by the new hibernation sub-plugin.

### Single resume primitive — `ensureResumed(id)`

Generalize the existing `resumeConversation` in `plugins/conversations/server/internal/lifecycle.ts:232`. Add:

```ts
// idempotent: no-op if not hibernated
async function ensureResumed(id): Promise<void>
```

If `hibernatedAt` is set: `runtime.delete(id)` (clear stale dead pane) → `updateConversation(id, { status: "starting", endedAt: null })` → `runtime.create(id, worktreePath, { resumeSessionId: claudeSessionId, model })` → `setConversationHibernated(id, null)`. This reuses the exact proven resume path. Keeping `status: "starting"` preserves the 30s `STARTING_TIMEOUT_MS` safety net so a **failed** resume surfaces as `gone` (fail loudly) instead of silently re-hibernating in a loop. The brief "Starting" is invisible in practice (transcript renders from disk).

`ensureResumed` is the chokepoint called before **any** live-process interaction:
- The viewed/select endpoint (primary trigger — user opens the conversation).
- `sendTurn` (a queued/meta-prompt turn must not be sent to a dead pane).
- (Terminal-pane attach is covered transitively — it opens inside an already-opened conversation, which already fired the viewed endpoint.)

### Poller change — suspend instead of `gone`

In `plugins/conversations/server/internal/poller.ts`, the missing-session loop (lines ~218–253) currently marks every non-`gone`/`done` row `gone`. Insert a new branch **before** the gone path, after the existing `closeRequested` check (close still wins):

```
if getConfig(hibernationConfig).enabled
   && dbRow.status === "waiting"
   && dbRow.claudeSessionId        // resumable
   && !dbRow.hibernatedAt:
       setConversationHibernated(id, now); changedIds.add(id); continue;   // keep status "waiting"
```

This single branch handles **both** triggers:
- **Reboot:** first tick after restart finds the session missing → waiting+resumable rows become hibernated (status stays `waiting`), never `gone`.
- **Post proactive-kill:** the row is already hibernated → falls through to `continue` (no-op).

Gate on `isMain()` consistent with the existing orphan-adoption guard (verify poller/DB scoping during implementation — only main owns the canonical conversation rows). `hibernatedAt` is cleared **only** by `ensureResumed`; the poller never clears it.

### New sub-plugin — `plugins/conversations/plugins/hibernation/`

Owns the separable *policy* pieces (the lifecycle wiring above stays in core conversations):

- **server**
  - `defineJob` `conversations.hibernate-idle`, `dedup: "singleton"`, **schedule** `cron: "*/30 * * * *"` (mirrors `database/fork-temp-sweep`), main-only. Run: skip if `!getConfig(hibernationConfig).enabled`; `before = now - idleHours`; for each `listHibernationCandidates(before)`: **`deleteConversation(id)` (kills tmux) then `setConversationHibernated(id, now)`** (kill-first ordering self-heals via the poller branch if the job dies between the two).
  - Endpoint `POST /api/conversations/:id/viewed` → `touchConversationViewed(id)` then `ensureResumed(id)`.
  - Registers `hibernationConfig` (`ConfigV2.WebRegister`).
  - Imports `ensureResumed`/`deleteConversation` from `@plugins/conversations/server` (child→parent, no cycle — the parent never imports the child; config lives in `conversations/core`).
- **web**
  - `markConversationViewed(id)` client wrapper over the endpoint.

### Client — record selection

In the conversation-view pane host (`plugins/conversations/plugins/conversation-view/...`), call `markConversationViewed(convId)` on mount and on `convId` change (imported from `@plugins/conversations/plugins/hibernation/web`). This is the selection signal that both resets the idle timer and triggers `ensureResumed`.

### Visibility

Per the requirement the state is **invisible** to the user — no badge, status stays `waiting`. Surface `hibernatedAt` only for debugging (already inspectable via `query_db`; optionally show it in the Debug → Recovery/`live-state-health` panes — not required for v1).

## Critical files

- `plugins/tasks/plugins/tasks-core/server/internal/tables.ts` — add `hibernatedAt`, `lastViewedAt` columns.
- `plugins/tasks/plugins/tasks-core/server/internal/schema.ts` / repo — `ConversationSchema`, the 3 helpers + infra projection.
- `plugins/conversations/server/internal/lifecycle.ts` — `ensureResumed` (generalize `resumeConversation`).
- `plugins/conversations/server/internal/poller.ts` — suspend-instead-of-`gone` branch.
- `plugins/conversations/server/internal/send-turn` (wherever `sendTurn` lives) — call `ensureResumed` first.
- `plugins/conversations/core` — `hibernationConfig` definition.
- `plugins/conversations/plugins/hibernation/{core,server,web}/**` — new sub-plugin (job, endpoint, config registration, client wrapper).
- `plugins/conversations/plugins/conversation-view/...` pane host — fire `markConversationViewed`.

## Reused existing infra

- `resumeConversation` / `tmuxRuntime.create({ resumeSessionId })` — the resume mechanism (`claude --resume`).
- `tmuxRuntime.delete` / `deleteConversation` — the single tmux kill point.
- `defineJob` + `schedule.cron` — precedents: `database/fork-temp-sweep` (`*/15 * * * *`), `conversations/transcript-retention` (daily).
- `isMain()` guard pattern (auto-start jobs, poller orphan adoption).
- `config_v2` (`getConfig` / `ConfigV2.WebRegister`) — same shape as `autoAnswerConfig` read in the poller.

## Edge cases

- **No `claudeSessionId`** (never wrote a transcript): not hibernatable; on reboot still → `gone` (genuinely unrecoverable). The poller branch and candidate query both guard on it.
- **`closeRequested`**: handled before hibernation in the poller — closing wins.
- **`done`**: already skipped by the poller.
- **Failed resume**: `status: "starting"` → 30s timeout → `gone` (loud), no silent loop.
- **Delete while hibernated**: `deleteConversation` (pane already dead) + row removal — fine.
- **Working/starting at reboot**: ineligible → `gone` as today (in-flight turn was lost regardless).

## Verification

1. `./equin build`; open `http://<worktree>.localhost:9000`.
2. **Proactive hibernate:** create a conversation, let it reach `waiting`. Temporarily set `hibernationConfig.idleHours` low (e.g. `0`) in the Config pane and run/await the `conversations.hibernate-idle` job (Debug → Queue can trigger/inspect). Confirm: `tmux ls` no longer shows the session; the sidebar still lists it as **Waiting** (not Disconnected); `query_db` shows `hibernated_at` set, `status = 'waiting'`.
3. **Transparent restore:** open that conversation. Confirm: transcript renders instantly; `tmux ls` shows a fresh session; `query_db` shows `hibernated_at` cleared; status returns to `waiting`/`working`; sending a turn works. No visible disruption.
4. **Reboot transparency:** `tmux kill-server` (simulates reboot — kills all sessions). Within ~1s confirm waiting conversations stay **Waiting** with `hibernated_at` set (not `gone`), while any `working` conversation goes **Disconnected** (`gone`). Open a waiting one → resumes transparently.
5. **Idle-timer reset:** open a conversation (sets `lastViewedAt`), confirm the next job run does not hibernate it.
6. Optional: a `bun:test` for `listHibernationCandidates` eligibility filtering (status/sessionId/threshold) co-located in tasks-core.

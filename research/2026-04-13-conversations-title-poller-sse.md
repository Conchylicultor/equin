# Conversation title poller + SSE broadcast

## Context

The `conversations.title` column exists (`plugins/conversations/server/schema.ts:1-10`) but is never written. Today, `listConversations()` (`plugins/conversations/server/internal/tmux.ts:73-96`) spawns `tmux list-sessions` on every HTTP call and merges cleaned `pane_title` into the response as `task`. The client re-fetches on mount and after user actions; there is no live update when the pane title changes.

Goal: a background poller owns tmux state. It (a) persists `title` to the DB, (b) streams title + the two live tmux fields actually consumed (`task`, `idle`) to the frontend over SSE. The HTTP list endpoint becomes a pure DB read — it no longer spawns tmux.

Scope decisions (per user + audit of consumers):
- Persist **title only**. `task` and `idle` are live data, streamed but not in the DB.
- **Drop `attached`** — no consumer reads it anywhere in the codebase.
- **Drop `cwd` from the live SSE payload** — only consumer is the VSCode plugin. Instead, expose `worktreePath` on the persisted DTO, derived server-side.
- **Drop the redundant `conversations.worktree` column** (`schema.ts:5`). It always equals `id` (set at `tmux.ts:119` as `worktree: name`, `name === id`). `id` is the canonical worktree name; clients that want the name use `conversation.id`.
- **Derive `worktreePath` in the DTO**: cache `repoRoot` once at plugin module load via the existing `getRepoRoot()` in `tmux.ts`, then every list row returns `worktreePath = ${repoRoot}/.claude/worktrees/${id}`. Derivation is safer than persisting: if the worktree layout changes, old rows still resolve to the new layout instead of pointing at a stale path.
- Do **not** derive/broadcast `conversation.status` from tmux in this pass. The DB's `status` field (start/running/done/etc.) is a separate, higher-level concept than the tmux idle/running/gone state; conflating them now would be a mistake. Deferred as future work.
- Remove the tmux spawn from `listConversations` entirely. HTTP returns DB rows; live tmux fields arrive via SSE.

## How SSE fits the plugin system

The server plugin interface (`server/src/types.ts`) already supports arbitrary HTTP responses — handlers return `Response | Promise<Response>`. SSE is just a GET handler returning a `Response` that wraps a `ReadableStream` with `content-type: text/event-stream`. No new plugin primitive required.

A plugin owning an SSE endpoint keeps a module-level `Set<ReadableStreamDefaultController>` of active subscribers, enqueues `data: ...\n\n` frames on events, and removes the controller on `cancel`. Mirrors the in-memory listener pattern from `plugins/logs/server/internal/registry.ts:19-60` but over HTTP. The Vite dev proxy already forwards `/api/*`, so no proxy config is needed.

## Design

### 1. Poller (`plugins/conversations/server/internal/poller.ts`, new)

- Module-level `Map<sessionName, TmuxInfo>` — the authoritative in-memory snapshot.
- `startPoller()` runs `setInterval(tick, 1000)` and is called at plugin module load.
- `tick()`:
  1. Run `listTmuxSessions()` (exported from `tmux.ts`; already exists at `tmux.ts:43-71`).
  2. Diff new vs. previous snapshot:
     - **`task` or `idle` changed** → emit `{ type: "tmux", id, task, idle }`.
     - **Session disappeared** → emit `{ type: "tmux", id, gone: true }`.
     - **`task` / idle transition** → also compute desired DB `title`: `idle ? null : task`. If different from current DB value, `UPDATE conversations SET title=?, updatedAt=now() WHERE id=?` and emit `{ type: "title", id, title }`.
  - The poller still tracks `attached` and `cwd` internally if cheap, but only `task` and `idle` are emitted.
  3. Replace the snapshot.
- DB reads to compare against current `title`: one `SELECT id, title FROM conversations` per tick (cheap; rows are few). Alternatively keep a second map `lastPersistedTitle: Map<id, string|null>` primed from DB on start to avoid the per-tick SELECT — micro-optimization, choose per taste at implementation time.
- A tick's errors are logged and swallowed; the interval keeps running.

### 2. SSE hub (`plugins/conversations/server/internal/sse.ts`, new)

```ts
const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();

export function broadcast(event: ConversationEvent) {
  const frame = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  for (const c of subscribers) {
    try { c.enqueue(frame); } catch { subscribers.delete(c); }
  }
}

export function handleStream(_req: Request): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      subscribers.add(controller);
      // Prelude + initial snapshot so new clients don't wait a tick for live fields
      controller.enqueue(encoder.encode(": ok\n\n"));
      for (const [id, info] of getSnapshot()) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "tmux", id, ...info })}\n\n`),
        );
      }
    },
    cancel(controller) { subscribers.delete(controller); },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    },
  });
}
```

`getSnapshot()` is exported from the poller module.

### 3. Event types (`plugins/conversations/shared/protocol.ts`, new)

```ts
export type ConversationEvent =
  | { type: "title"; id: string; title: string | null }
  | { type: "tmux"; id: string; task: string; idle: boolean }
  | { type: "tmux"; id: string; gone: true };
```

### 4. HTTP: pure DB read

- `plugins/conversations/server/internal/handle-list.ts` — replace with a plain `SELECT * FROM conversations` mapping rows to the DTO. Response fields: `id`, `worktreePath` (derived), `title`, `status`, `createdAt`. No tmux spawn. `getRepoRoot()` is called once at plugin module load and memoized.
- `createConversation()` — drop the `worktree:` insert value (column goes away).
- DB migration: drop `worktree` column. Generated by `./equin build`.
- `plugins/conversations/shared/types.ts` — strip `task/idle/attached/cwd` from `Conversation`. Add a small `TmuxLive = { task: string; idle: boolean }` type used by the SSE event and frontend state.

### 5. Plugin wiring (`plugins/conversations/server/index.ts`)

- Register `"GET /api/conversations/stream": handleStream`.
- At module top-level: `startPoller()`.
- Update `plugins/CLAUDE.md` entry for `conversations` to list the new route.

### 6. Frontend (`plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx`)

- Initial `fetch("/api/conversations")` → DB rows only (`id`, `title`, `status`, `createdAt`). Store in state keyed by id.
- Separate state: `Map<id, TmuxLive>` for live fields.
- On mount: `const es = new EventSource("/api/conversations/stream")`.
  - `message` handler parses `ConversationEvent`:
    - `title` → update the conversation's `title` in the list state.
    - `tmux` with `gone` → delete the id from the live map.
    - `tmux` otherwise → set id → `{ task, idle }`.
  - Close `es` on unmount.
- Render label: `title ?? live[id]?.task ?? "Idle"`. Idle styling driven by `live[id]?.idle ?? true`.
- VSCode plugin (`plugins/conversations/plugins/conversation-view/plugins/vscode/web/index.ts`) — change `record.cwd` → `record.worktreePath`.
- Remove the existing post-action refetch for fields now covered by SSE. Keep a refetch (or optimistic update) after `POST`/`DELETE` since those add/remove conversations.

### Status

Not touched in this pass. `conversations.status` stays as-is (whatever `createConversation` writes). Future work: design how to derive a meaningful `ConversationStatus` from tmux + conversation activity, likely a separate plugin concern.

## Critical files

- `plugins/conversations/server/internal/tmux.ts` — export `listTmuxSessions`, `cleanPaneTitle`; strip the `listConversations` tmux merge (or move it out and simplify).
- `plugins/conversations/server/internal/poller.ts` — new.
- `plugins/conversations/server/internal/sse.ts` — new.
- `plugins/conversations/server/internal/handle-list.ts` — pure DB read.
- `plugins/conversations/shared/protocol.ts` — new (event union).
- `plugins/conversations/shared/types.ts` — split `Conversation` (persisted) and `TmuxInfo` (live).
- `plugins/conversations/server/index.ts` — register stream route + call `startPoller()`.
- `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx` — EventSource subscription, split state, render precedence.
- `plugins/CLAUDE.md` — document `GET /api/conversations/stream`.

No DB migration needed.

## Verification

1. `./equin build` — server restarts, migrations no-op.
2. `curl -N http://<worktree>.localhost:9000/api/conversations/stream` — prelude `: ok`, then one `data: {"type":"tmux",...}` per current session. Keep stream open for step 4.
3. `curl http://<worktree>.localhost:9000/api/conversations` — rows contain `id`, `title`, `status`, `createdAt` only (no tmux fields).
4. In a tmux session for a conversation, change the pane title: `tmux send-keys -t claude-... "printf '\\033]2;hello world\\007'" Enter`. Within ~1s:
   - curl stream receives `{ type: "title", id, title: "hello world" }` and a `tmux` event with the new `task`.
   - `psql -c "select id, title from conversations where id='claude-...'"` shows `hello world`.
   - UI: conversation row label updates without reload.
5. `tmux kill-session -t claude-...` → stream receives `{ type: "tmux", id, gone: true }`. UI row shows "Idle" styling (title stays as last persisted until re-filled).
6. Refresh the UI — initial GET returns DB rows, SSE reconnect re-sends the full tmux snapshot, live fields reappear within one frame.

## Follow-ups (out of scope)

- Derive `ConversationStatus` (start / running / done / error) from tmux + session activity; broadcast on change.
- Replace the 1s poll with tmux control-mode if cost matters (unlikely at current scale).
- Reconcile SSE subscriber cleanup on server shutdown once shutdown hooks land.

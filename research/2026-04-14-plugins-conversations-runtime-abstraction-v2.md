# Conversations: runtime abstraction + Claude session id (v2)

Revises v1 with three changes requested during review:

1. **No `RuntimeKind` enum.** Runtime identity is a free-form string chosen by the implementing plugin, stored as `text` in the DB. Fully extensible: adding a third backend later means adding a plugin, not editing a union.
2. **`title` instead of `task`** in the runtime interface — matches `conversation.title`, removes the translation step in the poller.
3. **Runtime registration is plugin-driven**, via a public `api.ts` exported by the `conversations` plugin. Each backend lives in its own plugin and self-registers at server boot, mirroring the pattern already used by `logs` (see `plugins/logs/server/api.ts` → imported by `build`).

## Context

The `conversations` plugin today hard-codes tmux: poller, lifecycle, and the SSE `tmux` event all live in `plugins/conversations/server/internal/tmux.ts` + `poller.ts`. We want a second backend in the future — Claude in-process via the Anthropic Agent SDK — without rewiring the plugin each time. Both backends must coexist per-conversation.

Secondary goal: capture and persist the **Claude session id** (read from `~/.claude/sessions/<pid>.json`) so the UI can deep-link to transcripts and future features have a stable handle on the underlying Claude session. Confirmed that file exists on this machine.

## Design

### 1. `ConversationRuntime` interface

`plugins/conversations/server/api.ts` (new, public entry point of the plugin):

```ts
export interface RuntimeInfo {
  title: string;                   // "" when idle
  idle: boolean;                   // true = waiting for user input
  claudeSessionId: string | null;  // from ~/.claude/sessions/<pid>.json; null until resolved
}

export interface ConversationRuntime {
  /** Stable identifier stored in `conversations.runtime`, e.g. "tmux", "api". */
  readonly id: string;

  /** Start a new conversation: spawn Claude. Environment (worktree, DB fork) is already set up by the caller. */
  create(conversationId: string, worktreePath: string): Promise<void>;

  /** Terminate a running conversation. Idempotent. */
  delete(conversationId: string): Promise<void>;

  /** Snapshot of live conversations owned by this runtime, keyed by conversation id. */
  list(): Promise<Map<string, RuntimeInfo>>;
}

export const Runtime = {
  register(runtime: ConversationRuntime): void { ... },
  get(id: string): ConversationRuntime { ... },   // throws if unknown — caller error
  all(): ConversationRuntime[] { ... },           // used by the poller
};
```

The registry is a module-level `Map<string, ConversationRuntime>`. Double-registration throws. Consumers import from `@plugins/conversations/server/api`.

### 2. Split into runtime plugins

Two new plugins, each tiny:

- **`plugins/conversations/plugins/runtime-tmux`** — calls `Runtime.register(tmuxRuntime)` in its `server/index.ts`. Owns all tmux code that currently lives in `conversations/server/internal/tmux.ts` (spawn, kill, `listTmuxSessions`, pane_title cleaning). Also owns the Claude-session-id resolver (pane_pid → `pgrep -P` → `~/.claude/sessions/<pid>.json`, cached per-pid).
- **`plugins/conversations/plugins/runtime-api`** — stub that registers a runtime with id `"api"` whose methods throw `NotImplemented`. Exists so the abstraction has two real consumers and so the slot for the real SDK integration is already reserved.

Both are nested under the `conversations` plugin workspace (same convention as `plugins/conversations/plugins/conversation-view/`, `…/conversations-view/`), so they share the parent's `package.json` rather than needing their own.

The `conversations` plugin itself no longer knows tmux exists.

### 3. Lifecycle + poller stay in `conversations`

`plugins/conversations/server/internal/lifecycle.ts` (new):

```ts
export async function createConversation(runtimeId: string = "tmux"): Promise<Conversation> {
  const id = `claude-${Math.floor(Date.now() / 1000)}`;
  const wtPath = await worktreePathFor(id);
  await setupWorktree(id, wtPath);    // git worktree + forkDatabase (shared, runtime-agnostic)
  const [row] = await db
    .insert(conversations)
    .values({ id, worktreePath: wtPath, runtime: runtimeId })
    .returning();
  await Runtime.get(runtimeId).create(id, wtPath);
  return row!;
}

export async function deleteConversation(id: string): Promise<void> {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, id));
  await Runtime.get(row.runtime).delete(id);
}
```

`poller.ts` becomes runtime-agnostic:

```ts
const snapshots = await Promise.all(Runtime.all().map(r => r.list().then(m => [r.id, m] as const)));
// Flatten to Map<conversationId, { runtime, info }>, detect changes, broadcast, sync DB.
```

`title` from `RuntimeInfo` is written directly to `conversations.title` (no `task` → `title` translation). `claudeSessionId` is synced to the DB when it changes.

Worktree-path helpers (`getMainWorktreeRoot`, `worktreePathFor`) stay in `conversations/server/internal/` — they're shared infrastructure, not tmux-specific.

### 4. DB schema

`plugins/conversations/server/schema.ts`: add two columns.

```ts
runtime: text("runtime").notNull().default("tmux"),  // free-form id, no enum constraint
claudeSessionId: text("claude_session_id"),
```

Default `"tmux"` covers existing rows. Migration generated by `./equin build`.

### 5. Shared protocol

`plugins/conversations/shared/protocol.ts`: rename the `tmux` event to `live`, carry the runtime id and session id. Local app, single wire — rename freely.

```ts
export type ConversationEvent =
  | { type: "created"; conversation: Conversation }
  | { type: "deleted"; id: string }
  | { type: "title"; id: string; title: string | null }
  | { type: "live"; id: string; runtime: string; idle: boolean; claudeSessionId: string | null }
  | { type: "live"; id: string; gone: true };
```

Note the `live` payload drops the redundant `task` field — `title` flows through the existing `title` event.

### 6. Plugin wiring (order-sensitive)

Runtime plugins must register **before** the poller's first tick. Two options:

- **A.** `conversations/server/index.ts` calls `startPoller()` on first HTTP request, not on import. Simpler registration: every runtime plugin's `server/index.ts` runs `Runtime.register(...)` at import time, and plugin load order guarantees all registrations happen before any request.
- **B.** Keep eager `startPoller()`. Runtime plugins register at import; rely on load-order. Poller tolerates zero runtimes gracefully (empty snapshot, no broadcasts).

Recommend **B** — the poller already handles zero sessions (empty map). No new machinery.

## Critical files

**New:**
- `plugins/conversations/server/api.ts` — `ConversationRuntime`, `RuntimeInfo`, `Runtime` registry.
- `plugins/conversations/server/internal/lifecycle.ts` — create/delete orchestration.
- `plugins/conversations/plugins/runtime-tmux/` — child plugin: `server/index.ts`, `server/internal/tmux-runtime.ts`, `server/internal/claude-session.ts` (pid→sessionId resolver). No own `package.json` — shares parent.
- `plugins/conversations/plugins/runtime-api/` — child stub plugin: `server/index.ts` registers a throwing runtime.

**Modified:**
- `plugins/conversations/server/internal/tmux.ts` — reduce to shared worktree helpers (or rename to `worktree.ts`); move the rest into the tmux runtime plugin.
- `plugins/conversations/server/internal/poller.ts` — iterate `Runtime.all()`; use `info.title` directly.
- `plugins/conversations/server/internal/handle-create.ts`, `handle-delete.ts` — call lifecycle, not tmux.
- `plugins/conversations/server/schema.ts` — add `runtime`, `claudeSessionId`.
- `plugins/conversations/shared/protocol.ts`, `shared/types.ts` — rename `tmux` → `live`, extend payload.
- `plugins/conversations-view/web/…`, `plugins/conversation-view/web/…` — rename `tmux` event consumer; rename `TmuxLive` → `RuntimeLive`.
- `plugins/CLAUDE.md` — document the two new runtime plugins.
- Server plugin registry — add the two new child plugins to the list that gets loaded.

## Verification

1. `./equin build` — migration generated; server restarts; both runtime plugins log registration.
2. `http://<this-worktree>.localhost:9000` — sidebar still lists conversations; titles update live; idle/working transitions unchanged.
3. SQL: `SELECT id, runtime, claude_session_id FROM conversations;` — `runtime = "tmux"` for all rows; `claude_session_id` populated within a few seconds for any active session.
4. Create a new conversation from the UI → row has `runtime = "tmux"`, tmux session spawns.
5. Delete from the UI → tmux session killed, DB row removed.
6. `Runtime.get("api")` is registered but never invoked — server boots cleanly; no web-visible change.
7. No regression in the `status` toolbar plugin — transitions still driven by `title` + `idle`.

## Out of scope (follow-ups)

- Real Anthropic Agent SDK implementation of the `api` runtime.
- UI surfacing of `claudeSessionId` (deep link to transcript, resume).
- Transcript jsonl `mtime` as a corroborating "active" signal — revisit only if the `pane_title` spinner proves insufficient.

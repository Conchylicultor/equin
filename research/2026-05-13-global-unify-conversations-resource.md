# Unify duplicate `conversations` resource descriptors

## Context

Two separate objects named `recentConversationsResource` exist with key `"conversations"`:

- **Client-side descriptor** (`ResourceDescriptor`) in `plugins/conversations/core/resources.ts` — `{ key, schema, initialData }` for `useResource()` on the web
- **Server-side live resource** (`Resource`) in `plugins/tasks-core/server/internal/resources.ts` — `defineResource()` with loader, `.notify()`, `dependsOn`

Both use the same `ConversationListPayloadSchema` from `tasks-core/core/schemas.ts`. Having two objects with the same name and key in different plugins is confusing, and if someone changes the key or schema in one place but not the other, drift is silent.

**Goal:** single source of truth for the resource identity, private server-side implementation, no same-name confusion.

## Design

### Source of truth: `conversations/core`

`conversations/core/resources.ts` owns the canonical descriptor — key, schema, initialData. The server derives from it.

### Server-side resource: private + function API

`tasks-core/server/internal/resources.ts` creates the live resource using the descriptor's `key` and `schema`. The live resource stays **private** (not barrel-exported). External callers use `notifyConversationsChanged()` instead of `.notify()`.

For the two `dependsOn` wiring sites (internal `attemptsResource` + external `agents`), the live resource is exported under the distinct name `conversationsLiveResource`.

### Naming

| Symbol | Location | Purpose |
|---|---|---|
| `conversationsResource` | `conversations/core` | Client descriptor for `useResource()` |
| `notifyConversationsChanged()` | `tasks-core/server` barrel | Push update to all clients |
| `conversationsLiveResource` | `tasks-core/server` barrel | `dependsOn` wiring only |

## Changes

### 1. `plugins/conversations/core/resources.ts` — become source of truth

- Import `ConversationSchema` from `@plugins/tasks-core/core`
- Define `ConversationListPayloadSchema` locally (module-private, not exported)
- Rename export: `recentConversationsResource` → `conversationsResource`
- Keep `ConversationListPayload` type and `ConversationEntry` alias

### 2. `plugins/conversations/core/index.ts` — update barrel

- `recentConversationsResource` → `conversationsResource`

### 3. `plugins/tasks-core/core/schemas.ts` — remove payload schema

- Remove `ConversationListPayloadSchema` and `ConversationListPayload` (no external consumers)
- Keep `ConversationSummarySchema` and `AttemptWithConversationsSchema`

### 4. `plugins/tasks-core/core/index.ts` — remove from barrel

- Remove `ConversationListPayloadSchema` and `ConversationListPayload` exports

### 5. `plugins/tasks-core/server/internal/resources.ts` — derive from descriptor

- Import `conversationsResource` from `@plugins/conversations/core`
- Use `conversationsResource.key` and `conversationsResource.schema`
- Rename `recentConversationsResource` → `conversationsLiveResource`
- Update internal `attemptsResource.dependsOn` reference

### 6. `plugins/tasks-core/server/index.ts` — new barrel exports

- Replace `recentConversationsResource` with `conversationsLiveResource` + `notifyConversationsChanged`
- Add inline function:
  ```ts
  export { conversationsLiveResource } from "./internal/resources";
  export function notifyConversationsChanged(): void {
    conversationsLiveResource.notify();
  }
  ```
- Update `Resource.Declare(...)` in contributions array

### 7. Internal `.notify()` callers (2 files in `tasks-core/server/internal/mutations/`)

- `conversations.ts`: rename import `recentConversationsResource` → `conversationsLiveResource`
- `cross-table.ts`: same rename

### 8. External `.notify()` callers (9 files)

Each file: replace `recentConversationsResource` import with `notifyConversationsChanged`, replace `.notify()` call.

| File | Other tasks-core imports? |
|---|---|
| `conversations/server/internal/handle-close.ts` | yes (`markConversationClosed`) |
| `conversations/server/internal/handle-create.ts` | sole import |
| `conversations/server/internal/poller.ts` | yes (6 others) |
| `conversation-view/plugins/exit/server/index.ts` | yes (2 others) |
| `conversation-view/plugins/resume/server/index.ts` | sole import |
| `conversation-view/plugins/hold-and-exit/server/index.ts` | yes (3 others) |
| `conversation-view/plugins/drop-and-exit/server/index.ts` | yes (5 others) |
| `conversation-view/plugins/push-and-exit/server/internal/exit-clean-finalize-job.ts` | yes (1 other) |
| `conversations-recover/server/internal/handle-restore-batch.ts` | sole import |

### 9. `dependsOn` caller: `plugins/agents/server/internal/resources.ts`

- Replace `recentConversationsResource` with `conversationsLiveResource` in import and `dependsOn` array

### 10. Client-side `useResource()` callers (3 files)

- `conversations/web/use-conversations.ts` — imports from `"../core/resources"`, rename to `conversationsResource`
- `conversations/plugins/conversations-view/web/components/auto-launch-watcher.tsx` — rename import
- `conversations-recover/web/components/recovery-view.tsx` — rename import

## Verification

1. `rg "recentConversationsResource" plugins/ -g '*.ts' -g '*.tsx'` → zero hits
2. `rg "ConversationListPayloadSchema" plugins/tasks-core/ -g '*.ts'` → zero hits
3. `./equin build` succeeds
4. App loads at `http://<worktree>.localhost:9000`, conversation list populates correctly

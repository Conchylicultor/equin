# Resource initialData — eliminate `T | undefined` from useResource

## Context

`useResource(descriptor)` wraps TanStack Query's `useQuery` and returns `UseQueryResult<T>` where `data: T | undefined`. Every array-typed consumer writes `const tasks = data ?? []`, creating a fresh `[]` ref on every render when `data` is `undefined`. When that ref appears in a `useMemo`/`useCallback` dependency array, the memo is defeated — it re-runs every frame during the initial loading window.

ESLint's `react-hooks/exhaustive-deps` flags 5 call sites with this anti-pattern. But the root cause is the API: `useResource` forces every consumer to handle a loading state that every resource handles identically. Fixing the ~5 sites individually doesn't prevent agents from re-introducing the pattern.

**Goal:** Make `initialData` required on `ResourceDescriptor` so `useResource` always returns `DefinedUseQueryResult<T>` where `data: T`. No overloads, no `T | undefined`, no `?? []` ever written. The type system enforces correctness — agents can't forget.

TanStack Query v5's `useQuery` already supports this: passing `initialData: T` selects the `DefinedUseQueryResult<T>` return type where `data: T`.

**Loading state:** `initialData` makes TanStack's `isLoading` false immediately (the query starts in `success` state). Two consumers currently use `isLoading` to show loading UI. `useResource` passes `initialDataUpdatedAt: 0` so `dataUpdatedAt` starts at 0 and jumps to `Date.now()` when `setQueryData` (WS sub-ack) overwrites the initial value. Consumers that need loading state check `dataUpdatedAt === 0`.

Secondary: promote `react-hooks/rules-of-hooks` from `"warn"` to `"error"` (0 violations, pure safety net).

## Implementation

### Step 1 — Make `initialData` required on ResourceDescriptor

**File:** `plugins/primitives/plugins/live-state/shared/resource.ts`

```ts
export interface ResourceDescriptor<T, P extends Record<string, string> = Record<string, string>> {
  key: string;
  origin?: ResourceOrigin;
  schema: ZodType<T>;
  initialData: T;              // REQUIRED — was absent
  readonly __params?: P;
}

export function resourceDescriptor<T, P extends Record<string, string> = Record<string, never>>(
  key: string,
  schema: ZodType<T>,
  initialData: T,              // REQUIRED third arg
): ResourceDescriptor<T, P> {
  return { key, schema, initialData };
}

export function centralResourceDescriptor<T, P extends Record<string, string> = Record<string, never>>(
  key: string,
  schema: ZodType<T>,
  initialData: T,              // REQUIRED third arg
): ResourceDescriptor<T, P> {
  return { key, origin: "central", schema, initialData };
}
```

No overloads needed — single signature, `initialData` always present.

### Step 2 — Simplify useResource return type

**File:** `plugins/primitives/plugins/live-state/web/use-resource.ts`

Import `DefinedUseQueryResult` from `@tanstack/react-query`. Single return type — no overloads:

```ts
export function useResource<T, P extends ResourceParams = ResourceParams>(
  resource: ResourceDescriptor<T, P>,
  params?: P,
): DefinedUseQueryResult<T> {
  // ... existing setup unchanged ...

  return useQuery({
    queryKey: queryKeyFor(key, p),
    queryFn: async () => { /* unchanged */ },
    initialData: resource.initialData,
    initialDataUpdatedAt: 0,
  });
}
```

`initialDataUpdatedAt: 0` ensures `dataUpdatedAt` starts at 0 and updates to `Date.now()` when `setQueryData` (WS sub-ack) arrives. Consumers that need loading state check `dataUpdatedAt === 0`.

Update the barrel export (`plugins/primitives/plugins/live-state/web/index.ts`) — re-export `DefinedUseQueryResult` if not already available.

### Step 3 — Migrate all resource descriptors

Add `initialData` as third argument to every `resourceDescriptor()` / `centralResourceDescriptor()` call.

**Array-typed resources** — `initialData: []`:

| Resource | File |
|---|---|
| `tasksResource` | `plugins/tasks/shared/resources.ts` |
| `attemptsResource` | `plugins/tasks/shared/resources.ts` |
| `pushesResource` | `plugins/tasks/shared/resources.ts` |
| `agentsResource` | `plugins/agents/shared/resources.ts` |
| `agentLaunchesResource` | `plugins/agents/shared/resources.ts` |
| `agentAutoLaunchResource` | `plugins/agents/plugins/auto-launch/plugins/toggle/shared/resources.ts` |
| `serversResource` | `plugins/apps/plugins/deploy/plugins/servers/shared/resources.ts` |
| `notificationsResource` | `plugins/notifications/shared/resources.ts` |
| `claudeCliCallsResource` | `plugins/infra/plugins/claude-cli/shared/resources.ts` |
| `taskAutoStartResource` | `plugins/tasks/plugins/auto-start/shared/resources.ts` |
| `launchPromptsResource` | `plugins/conversations/plugins/conversation-view/plugins/launch-prompts/shared/resources.ts` |
| `quickPromptsResource` | `plugins/conversations/plugins/conversation-view/plugins/quick-prompts/shared/resources.ts` |
| `editedFilesResource` | `plugins/conversations/plugins/conversation-view/plugins/code/shared/resources.ts` |
| `queueRanksResource` | `plugins/conversations/plugins/conversations-view/plugins/queue/shared/resources.ts` |
| `conversationCategoriesResource` | `plugins/conversations/plugins/conversation-category/shared/schemas.ts` |
| `conversationProgressResource` | `plugins/conversations/plugins/conversation-progress/shared/schemas.ts` |
| `buildHistoryResource` | `plugins/build/shared/resources.ts` |
| `activeDataBindingsResource` | `plugins/active-data/shared/resource.ts` |
| `jsonlEventsResource` | `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/shared/protocol.ts` |

**Record-typed resources** — `initialData: {}`:

| Resource | File |
|---|---|
| `configResource` | `plugins/config/web/internal/config-client.ts` |
| `configSecretsResource` | `plugins/config/web/internal/config-client.ts` |
| `pushAndExitResource` | `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/shared/resources.ts` |
| `conversationNotesResource` | `plugins/conversations/plugins/conversation-view/plugins/notes/shared/schemas.ts` |
| `turnSummariesResource` | `plugins/conversations/plugins/conversation-view/plugins/turn-summary/shared/schemas.ts` |
| `conversationSummariesResource` | `plugins/conversations/plugins/summary/shared/resources.ts` |
| `reorderPrefsResource` | `plugins/reorder/shared/resource.ts` |
| `excludedPathStateResource` | `plugins/stats/plugins/commits/web/components/excluded-path-toggles.tsx` |

**Structured object resources:**

| Resource | File | `initialData` |
|---|---|---|
| `recentConversationsResource` | `plugins/conversations/shared/resources.ts` | `{ active: [], recentGone: [], hasMoreGone: false, totalGoneCount: 0, system: [] }` |
| `conversationGroupsResource` | `plugins/conversations/plugins/conversations-view/plugins/grouped/shared/internal/schemas.ts` | `{ groups: [], members: [] }` |
| `mainAheadCountResource` | `plugins/build/shared/resources.ts` | `{ count: 0 }` |
| `commitDeltaResource` | `plugins/conversations/plugins/conversation-view/plugins/commits-graph/shared/resources.ts` | `{ ahead: 0, behind: 0, mergeBase: null, branch: null }` |
| `commitsGraphResource` | `plugins/conversations/plugins/conversation-view/plugins/commits-graph/shared/resources.ts` | `{ ahead: 0, behind: 0, mergeBase: null, branch: null, commits: [], landedCommits: [], behindCommits: [] }` |
| `authStateResource` | `plugins/auth/shared/resources.ts` | `{ providers: {} }` |

**Nullable:**

| Resource | File | `initialData` |
|---|---|---|
| `forkErrorsResource` | `plugins/conversations/shared/fork-errors.ts` | `null` |

### Step 4 — Update isLoading consumers to use dataUpdatedAt

Two consumers use `isLoading` from `useResource`. With `initialData`, `isLoading` is always `false`. Replace with `dataUpdatedAt === 0`:

**File:** `plugins/active-data/web/internal/use-active-data-binding.ts`

```ts
// Before:
const { data, isLoading } = useResource(activeDataBindingsResource, ...);
return { value, isLoading, ... };

// After:
const { data, dataUpdatedAt } = useResource(activeDataBindingsResource, ...);
return { value, isLoading: dataUpdatedAt === 0, ... };
```

Consumer-facing `ActiveDataBindingHandle.isLoading` field unchanged — only its derivation changes.

**File:** `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/jsonl-pane.tsx`

```ts
// Before:
const { data, error, isLoading } = useResource(jsonlEventsResource, { id: conversation.id });
const events = data ?? null;
{events === null && isLoading ? (<Loading/>) : ...}

// After:
const { data: events, error, dataUpdatedAt } = useResource(jsonlEventsResource, { id: conversation.id });
{dataUpdatedAt === 0 ? (<Loading/>) : ...}
```

`data` is now `JsonlEvent[]` (never undefined), so `?? null` removed.

### Step 5 — Clean up useMemo anti-pattern sites

Remove `?? []` that was defeating useMemo:

| File | Change |
|---|---|
| `plugins/tasks/plugins/task-dependencies/web/components/task-dependencies.tsx:25` | `const { data } = …; const tasks = data ?? [];` → `const { data: tasks } = …;` |
| `plugins/tasks/plugins/task-graph/web/components/task-graph.tsx:225` | `const { data } = …; const allTasks = data ?? [];` → `const { data: allTasks } = …;` |
| `plugins/conversations/plugins/conversations-view/plugins/grouped/web/components/grouped-conversation-list.tsx:87-89` | Remove `data?.groups ?? []` / `data?.members ?? []`; destructure `{ groups, members }` from `data` directly |
| `plugins/conversations/plugins/conversations-view/plugins/grouped/web/components/grouped-conversation-list.tsx:161` | Remove `tasksData ?? []`; pass `tasksData` directly |

Other consumers' `?? []` becomes dead code but compiles fine — clean up incrementally.

### Step 6 — Promote rules-of-hooks to error

**File:** `eslint.config.ts`

```ts
"react-hooks/rules-of-hooks": "error",  // was "warn"
```

0 current violations.

## Verification

1. `bunx tsc --noEmit` — type-check passes; consumers with leftover `?? []` on migrated resources will have dead fallback code but no type errors.
2. `bunx eslint .` — the `exhaustive-deps` warnings for useMemo anti-patterns should be gone. `rules-of-hooks` now `error`.
3. `./equin build` — builds and deploys.
4. Browser:
   - Conversations list, task detail, task graph, grouped conversations view load correctly.
   - Active-data widgets still show loading state before WS response — no flash of editable card.
   - JSONL viewer still shows "Loading…" before events arrive.

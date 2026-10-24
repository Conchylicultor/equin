# useResource: Discriminated union return type

## Context

`useResource` returns `DefinedUseQueryResult<T>` — `data` is always `T` (never undefined) because TanStack's `initialData` is seeded. The `initialData` is tagged with `initialDataUpdatedAt: 0` as a sentinel, but this is invisible at the type level.

**Result:** only 5 of ~76 consumers check `dataUpdatedAt === 0`. The rest silently render with fake initial data (empty arrays, empty objects), producing plausible-but-wrong UI states (e.g. "all unranked" in reorder, empty lists that should show a loading indicator).

## New API

```ts
export type ResourceResult<T> =
  | { pending: true;  error: Error | null; refetch: () => Promise<void> }
  | { pending: false; data: T; error: Error | null; refetch: () => Promise<void> };
```

- `data` only exists on the `pending: false` branch. Accessing `.data` without narrowing is a **compile error** — no lint rule needed, TypeScript enforces it.
- `error` and `refetch` are on both branches (orthogonal to pending state). Used by 5 consumers total.
- `initialData` stays on `ResourceDescriptor` for TanStack internals but is never exposed to consumers.

### Consumer pattern

```tsx
const result = useResource(tasksResource);
if (result.pending) return null; // or <Placeholder>Loading…</Placeholder>
result.data // T, narrowed by TypeScript
```

## Implementation

### Step 1: Core type change

**`plugins/primitives/plugins/live-state/web/use-resource.ts`**

- Define `ResourceResult<T>` type (exported)
- Change `useResource` return type from `DefinedUseQueryResult<T>` to `ResourceResult<T>`
- Map TanStack result to the discriminated union:

```ts
const q = useQuery({ /* existing options unchanged */ });
if (q.dataUpdatedAt === 0) {
  return { pending: true, error: q.error as Error | null, refetch: () => q.refetch().then(() => {}) };
}
return { pending: false, data: q.data, error: q.error as Error | null, refetch: () => q.refetch().then(() => {}) };
```

- Remove unused `DefinedUseQueryResult` / `NonUndefinedGuard` imports (keep `NonUndefinedGuard` if still needed for the `initialData` cast)
- Update JSDoc and agent rule comment

**`plugins/primitives/plugins/live-state/web/index.ts`** — add `export type { ResourceResult }`.

**`plugins/primitives/plugins/live-state/core/resource.ts`** — update `initialData` JSDoc to note it's a cache-layer implementation detail, no longer consumer-facing.

### Step 2: Wrapper hooks (migrate first — unblocks most consumers)

| Hook | File | Migration |
|---|---|---|
| `useConversations()` | `plugins/conversations/web/use-conversations.ts` | `q.pending` → return empty fields + `isLoading: true`. After narrowing, destructure `q.data`. |
| `useConversation()` | same file | propagate pending from `useConversations()` — already returns `null` on miss |
| `useConversationById()` | same file | uses `useConversation` which returns null while pending — works |
| `useTask()` | `plugins/tasks/web/client.ts` | `if (result.pending) return null;` before `.find()` |
| `useConfigValues()` | `plugins/config/web/internal/config-client.ts` | `if (result.pending)` return defaults matching current `initialData: {}` behavior |
| `useSecretFieldSet()` | same file | same pattern |
| `useActiveDataBinding()` | `plugins/active-data/web/internal/use-active-data-binding.ts` | replace `dataUpdatedAt === 0` with `result.pending` |
| `useAuthState()` | `plugins/auth/web/hooks.ts` | return `ResourceResult<AuthStateValue>` directly |

### Step 3: Direct consumers (~70 call sites)

**Category A — inline chips/buttons (~40 sites): `return null` while pending**

Already handle empty data gracefully (`.find()` → undefined → `return null`). Add `if (result.pending) return null;` at the top. Examples:
- `task-link-chip.tsx`, `attempt-chip.tsx`, `task-card.tsx`
- `agent-avatar-*.tsx`, `agent-side-body.tsx`, `agent-status.tsx`
- `blocking-button.tsx`, `blocked-by-button.tsx`
- `commits-chip.tsx`, `build-button.tsx`
- All `*-settings.tsx` / `*-chips.tsx` config consumers

**Category B — pane/detail bodies (~15 sites): `<Placeholder>Loading…</Placeholder>`**

- `jsonl-pane.tsx` — replace `dataUpdatedAt === 0` check with `result.pending`; `error` moves to `result.error`
- `commits-graph-body.tsx` — uses `error`; moves to `result.error` after narrowing
- `agents-list.tsx`, `tasks-list.tsx`, `servers-list.tsx`
- `summary-pane.tsx`, `health-section.tsx`, `calls-view.tsx`

**Category C — effect-only watchers (~5 sites): early return**

- `auto-launch-watcher.tsx` — `if (result.pending) return;` replaces `dataUpdatedAt === 0`
- `bell-button.tsx` — `if (result.pending) return;` replaces `dataUpdatedAt > 0`
- `fork-error-watcher.tsx` — add `if (result.pending) return;`
- `recovery-view.tsx` — use `result.pending ? null : result.data` as effect dependency (reference changes on every push, replacing `dataUpdatedAt` as the trigger)

**Category D — list views (~10 sites): distinguish empty-pending from empty-ready**

- `queue-view.tsx` (conversations), `grouped-conversation-list.tsx` — use `useConversations()` which already has `isLoading`
- `dnd-list-middleware.tsx` — fall back to empty maps while pending (same as current `initialData` behavior, just explicit)

**Category E — refetch consumers (3 sites)**

- `debug/queue/queue-view.tsx` — 3 `useResource` calls that use `refetch`. `refetch` is on both branches, so destructure directly. Guard `data` access with pending check.

**Category F — subscribe-only (1 site)**

- `task-tree-detail.tsx` — `useResource(tasksResource)` with result discarded. No change needed.

### Step 4: Documentation

- Update `plugins/primitives/plugins/live-state/CLAUDE.md` — document `ResourceResult<T>`, remove `dataUpdatedAt === 0` guidance
- Run `./equin build` which regenerates `docs/plugins-details.md`

## Edge cases

1. **`recovery-view.tsx` naming conflict** — local `pending` state variable conflicts with `result.pending`. Rename the local to `restoring` or use `resource` as the result variable name (already does today).

2. **`useConversations` shape change** — currently `isLoading` comes from TanStack's `q.isLoading`, which is always `false` when `initialData` is set. With the new API, `pending` is `true` until WS sub-ack. This means `isLoading` now correctly reflects "not yet hydrated" — strictly better behavior. Consumers of `useConversations()` that check `isLoading` (history-view, grouped-view, queue-view, welcome-view) will now correctly show loading state instead of briefly flashing empty.

3. **Stable `refetch` reference** — wrap `q.refetch` in a `useCallback` to avoid triggering consumer effects on every render. Or just expose it inline since the 3 consumers only use it in click handlers (no effect dependencies).

## Verification

1. `bunx tsc --noEmit` — every consumer that accesses `.data` without narrowing will produce a compile error
2. `./equin build` — full build validates everything compiles and runs
3. Visual check: open the app, verify list views show a brief loading state instead of empty, then populate correctly
4. Check the reorder/DnD behavior — the original bug report — ranks should show as loading, not "all unranked"

# Live-state resource slice selectors — narrow re-renders for point/derived reads

## Context

`useConversation(id)` (`plugins/conversations/web/use-conversations.ts:35`) reads a
single conversation by id, but does it by subscribing to the **whole**
`conversationsResource` via `useConversations()` and running
`[...active, ...recentGone, ...system].find(x => x.id === id)`. Every
per-conversation toolbar component does this independently: exit, resume,
hold-and-exit, drop-and-exit, drop-dependents, push-and-exit, prompt-input,
prompt-template-chips, op-status (`use-worktree-op`), dependencies, etc.

On a live conversation page the `conversations` key reached **refcount = 175**
(one shared WS sub server-side — fine). The problem is on the **client**: every
`conversations` push re-renders all ~175 sharing components, because:

1. `useResource` reads `q.dataUpdatedAt` (for its `pending` flag). React Query
   tracks that prop, and `setQueryData` bumps `dataUpdatedAt` on **every** push —
   so every observer is notified on every push regardless of whether its slice
   changed.
2. `useConversations()` returns a fresh object literal and `useConversation`
   returns a fresh `.find()` result with nothing memoized, so even a memo'd
   consumer sees new references.

Net cost per push scales as **O(C²)** in the number of conversations C (175
observers each re-render and re-run an O(C) `find`). This re-render storm also
cascades into child mount/unmount churn (buttons that conditionally render on
`status`), which is the dominant driver of the live-state observe/unobserve log
volume (the 1193-event burst that recently overran the log emitter — the emitter
crash itself is already fixed by chunked flushing; this task is the underlying
inefficiency).

**The primitive gap:** `useResource` offers no way to subscribe to a derived
**slice** of a list resource and re-render only when that slice changes. The fix
belongs at the primitive level so every "read one item / one derived value from a
list resource" caller benefits — not just the conversations hooks.

**Goal:** reduce client re-renders and the resulting churn. **Non-goal:**
silencing the live-state trace — that trace is a useful always-on canary and
stays on.

## Why `select`, not entity-normalization

`select` is the idiomatic React Query primitive for "subscribe to a slice" and is
the same shape as Redux `useSelector` / Zustand selectors — the mainstream
professional pattern, not a workaround. Crucially the selector lives in **one**
place (the `useConversation` hook); all ~175 call sites stay clean
(`useConversation(id)` — no selector at the call site).

The more-automatic alternative is **entity normalization** (Apollo / Relay /
RTK Query): a flat `id → entity` cache with per-entity subscriptions and no
`.find()`. The repo already has the building block (the `keyed` delta-sync mode,
which preserves row references by id), but it requires a **flat array** payload.
`conversationsResource` is a paginated *struct* (`{ active, recentGone, system,
hasMoreGone, totalGoneCount }`), so normalization would mean reshaping the
payload or adding a parallel keyed resource — a larger architectural move than
the re-render storm warrants. Decision: ship `select` now; keep normalization as
a documented future evolution if point-lookup *compute* (the residual O(C²)
`find`, not re-renders) ever becomes a measured cost.

## Approach

### 1. Primitive: add a `select` option to `useResource`

`plugins/primitives/plugins/live-state/web/use-resource.ts`

Add an optional third `options` arg `{ select }` with typed overloads:

```ts
export function useResource<T, P extends ResourceParams = ResourceParams>(
  resource: ResourceDescriptor<T, P>,
  params?: P,
): ResourceResult<T>;
export function useResource<T, S, P extends ResourceParams = ResourceParams>(
  resource: ResourceDescriptor<T, P>,
  params: P | undefined,
  options: { select: (data: T) => S },
): ResourceResult<S>;
```

Implementation threads `select` into the existing `useQuery` call:

```ts
const q = useQuery({
  queryKey: queryKeyFor(key, p),
  queryFn: () => fetchResourceValue(resource, p),
  initialData: resource.initialData as NonUndefinedGuard<T>,
  initialDataUpdatedAt: 0,
  ...(select
    ? { select, notifyOnChangeProps: ["data", "error"] as const }
    : {}),
});
```

Why this works (React Query mechanics):
- **`select` + structural sharing** (RQ default): RQ runs `replaceEqualDeep` on
  the select output, so a selector returning a deeply-equal slice keeps its
  previous reference and the observer is **not** notified → no re-render. Only
  components whose specific slice actually changed re-render. This holds even
  though the resource is full-payload `update` mode (every push reparses the
  whole struct): the comparison happens on the **selected** value.
- **`notifyOnChangeProps: ["data", "error"]`**: scopes notifications to data/
  error changes so the `dataUpdatedAt` bump (which fires on every push) no longer
  forces a re-render. We still read `q.dataUpdatedAt` for `pending` — reading a
  prop does not re-enable it once `notifyOnChangeProps` is an explicit list.
- Applied **only when `select` is passed**, so existing whole-list consumers are
  byte-for-byte unchanged (they re-render on every push anyway because their
  `data` reference changes — correct for full-list views).

The rest of the hook is unchanged: `pending = q.dataUpdatedAt === 0`, `data =
q.data` (now `S` when `select` is given, `T` otherwise), same final `useMemo`.

Documented behavior caveat (add to the live-state `CLAUDE.md`): with `select`,
re-renders fire only when the **selected** value changes; if the selected slice
is identical across the initial-data→first-real-data boundary, the `pending`
flag flips silently with no re-render. Harmless for point lookups (caller sees
the same value either way). Callers should pass a **stable** selector
(`useCallback`) so `select` is not re-run every render.

No new exports — same `useResource` symbol, same barrel.

### 2. First adopter: `useConversation` point lookup

`plugins/conversations/web/use-conversations.ts`

```ts
export function useConversation(id: string): ConversationEntry | null {
  const select = useCallback(
    (p: ConversationListPayload): ConversationEntry | null =>
      p.active.find((x) => x.id === id) ??
      p.recentGone.find((x) => x.id === id) ??
      p.system.find((x) => x.id === id) ??
      null,
    [id],
  );
  const q = useResource(conversationsResource, undefined, { select });
  return q.pending ? null : q.data;
}
```

`useConversations()` (whole-list) and `useConversationById()` (which wraps
`useConversation`) are otherwise unchanged — `useConversationById` inherits the
slice-narrowing for free. After this, each of the ~175 toolbar
`useConversation(id)` observers re-renders only when **its** conversation row
changes, collapsing the O(C²) re-render storm to O(changed rows).

## Clean end state (the target the future migration drives toward)

`useConversations()` (the whole-list read) is used **only by true full-list
renderers** that must repaint on any membership/content change:
`conversations-view/{history,grouped,queue}`, `welcome`, `conv-count-label`.

**Every point or derived read goes through `useResource(..., { select })`** so it
re-renders only when its slice changes. No per-conversation toolbar component
calls the whole-list `useConversations()`. Concretely, the remaining derived-
boolean reads inside toolbar components migrate to named, memoized selector
hooks, e.g.:

- `drop-and-exit-button` / `drop-dependents`: `conv.active.some(c => c.taskId ===
  … && c.id !== …)` → a `useHasActiveSiblings(taskId, excludeId)` selector hook.
- `push-and-exit-button`: its `useConversations()` → `active` list usage →
  whatever precise slice it needs via a selector.

This is the same primitive (`select`) applied per call site; it does not need new
infrastructure. It is split out as a **follow-up** (filed as a task) rather than
bundled here to keep this change focused on the primitive + the dominant
175-sub fan-out (`useConversation`). The primitive also generalizes to other
list resources with point lookups (tasks/attempts/pushes) — those are future
adopters, not part of this work.

## Files to modify (this change)

- `plugins/primitives/plugins/live-state/web/use-resource.ts` — `select`
  overloads + `notifyOnChangeProps` wiring.
- `plugins/primitives/plugins/live-state/CLAUDE.md` — document the `select`
  slice-subscription capability and the `pending`-lag caveat.
- `plugins/conversations/web/use-conversations.ts` — migrate `useConversation`
  to a memoized `select`.

## Verification

1. `./equin build` (deploys to `http://<worktree>.localhost:9000`).
2. **Functional correctness** — scripted Playwright on a live conversation page,
   confirming the slice still updates the UI:
   ```bash
   bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/a/<attempt-id> \
     --out /tmp/conv
   ```
   Verify the conversation status badge and the exit/resume/push buttons still
   reflect live status changes (drive a status change by sending a turn or
   waiting for one), since `exit-button` etc. consume `useConversation(id).status`
   — proves the selector returns live data, not a stale snapshot.
3. **Re-render reduction** is correct by construction (RQ `select` +
   structural sharing + `notifyOnChangeProps`). Spot-check the secondary effect
   in the live-state-health debug pane (Debug → live-state health): the
   `conversations` sub still shows one shared sub with its refcount, and the
   observe/unobserve trace volume on a busy conversation page drops (fewer child
   mount/unmount cascades). Keep the trace always-on — do not silence it.
4. `./equin check` (eslint, boundaries, doc-in-sync).

## Follow-up (not in this change)

File a task: "Migrate per-conversation toolbar derived `useConversations()` reads
to `useResource` `select` slices (clean end state: `useConversations()` only in
full-list renderers)."

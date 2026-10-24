# Reusable `optimistic-mutation` primitive (over live-state)

> Status: plan / awaiting implementation
> Scope: **only** the reusable primitive. The block-editor re-architecture that
> motivated it (authoritative client document model + shared tree-op reducer +
> doc-level caret) is captured as a **separate sub-task** and is out of scope here.

## Context

The page block editor (`plugins/page/plugins/editor/`) has a cluster of
navigation/structure bugs (Enter mid-text duplicates text, Enter→Shift+Tab
deindents the wrong block, outdent sends a child to the end, etc.). The root
cause is architectural: the editor has **no authoritative client-side document
model**, and **every structural keystroke is a REST round-trip with no optimistic
apply** — the UI only updates when the live-state WS push echoes back. Chained
keystrokes therefore race against a stale snapshot.

Fixing that fully needs three things: a shared tree-op reducer, a doc-level caret
model, and — the foundation both depend on — **optimistic mutation**. The survey
of the codebase shows optimistic mutation is *not* an editor-only need:

| Surface | Resource | Mutation today | Optimistic today? |
|---|---|---|---|
| Queue reorder (`conversations/.../queue`) | `queueRanksResource` | `await fetchEndpoint(reorderQueue)` on drop | none — list snaps until WS push |
| Task tree move (`tasks/task-list/tree`) | `tasksResource` | `patchTask({folderId, rank})` | expand-only (TreeList) |
| Page tree move (`apps/pages/page-tree`) | `pagesResource` | `fetchEndpoint(moveBlock)` | expand-only (TreeList) |
| Block editor (`page/editor`) | `blocksResource` | split/indent/outdent/move/… | none |

There is **no general optimistic layer** today. The only optimistic patterns are
narrow local-state hacks (`SortableList.optimisticItems` = id-order only;
`TreeList.optimisticExpanded` = expanded-flag only). This plan extracts the
general mechanism as a primitive so all four surfaces (and the editor sub-task)
share one correct implementation.

## Design model: overlay/replay (rebase pending ops on server truth)

This is what modern sync engines do (Replicache, Linear, Figma): keep pending
local mutations **outside** the authoritative cache and **re-apply them on top of
each incoming server snapshot**, dropping each once the server confirms it.

Why not the simpler "write prediction into the cache + roll back on error":
live-state's WS push **overwrites the whole cache key** (`applyUpdate →
setQueryData(queryKeyFor(key,params), schema.parse(value))`, version-gated, drops
`version <= current`). Server versions are a per-`(key,params)` monotonic counter
minted on every `notify()` — **uncorrelated with any client op**. So a
`setQueryData` prediction is blown away by the next push (from this op, another
op, or another tab), re-creating today's race client-side. Overlay/replay never
writes the prediction into the cache, so no push can lose it:

```
rendered = pendingOps.reduce(apply, serverData)
// WS push overwrites serverData → rendered recomputes automatically,
// replaying the still-pending ops on the fresh base. Nothing is lost.
```

The pending overlay lives in React state colocated with the consumer — the exact
precedent of `SortableList.optimisticItems` / `TreeList.optimisticExpanded`,
generalized from "id-order / expanded-flag only" to an **arbitrary pure `apply`**.

## The primitive

**New plugin: `plugins/primitives/plugins/optimistic-mutation/`** (`web/` + a
small `core/` for shared types). Web-only.

Dependencies (barrel-only, boundary-legal):
- `@plugins/primitives/plugins/live-state/web` — `useResource`, `queryKeyFor`
  (both already exported from the barrel).
- `@tanstack/react-query` (root workspace dep) — `useQueryClient`, `QueryCache`
  subscription. Importing TanStack directly here avoids widening live-state's API.

Do **not** fold this into live-state: live-state's single responsibility is
"server truth → cache, version-gated"; it deliberately has no mutation/rollback
concept. A separate primitive that *depends on* it keeps that boundary clean
(mirrors `tree` depending on `rank`).

### API (`web/index.ts` barrel)

```typescript
export interface UseOptimisticResourceArgs<Data, Vars, P extends Record<string,string>> {
  resource: ResourceDescriptor<Data, P>;
  params?: P;
  /** Pure predicted next state. For the editor this is the shared tree reducer. */
  apply: (current: Data, vars: Vars) => Data;
  /** Network thunk; resolves on server 2xx (the op was accepted). */
  mutate: (vars: Vars) => Promise<void>;
  /**
   * Has this freshly-arrived server snapshot already reflected `vars`?
   * Default (coarse): clear once the mutation resolved AND >=1 push has landed
   * since. Override for precise content checks (e.g. "row id X present").
   */
  isConfirmedBy?: (serverData: Data, vars: Vars) => boolean;
  onError?: (err: unknown, vars: Vars) => void;
}

export interface UseOptimisticResourceResult<Data, Vars> {
  data: Data;                 // server truth with all pending ops replayed; never undefined
  pending: boolean;           // forwarded from useResource (dataUpdatedAt === 0)
  dispatch: (vars: Vars) => string;  // enqueue overlay op + fire mutate; returns opId
  inFlight: ReadonlyArray<{ opId: string; vars: Vars }>;
}

export function useOptimisticResource<Data, Vars, P extends Record<string,string>>(
  args: UseOptimisticResourceArgs<Data, Vars, P>,
): UseOptimisticResourceResult<Data, Vars>;
```

The `apply`/`mutate` pair lives at the hook level; `dispatch(vars)` is per-call,
so one hook instance handles every op kind on a resource (e.g. all of
split/indent/outdent share `apply = applyBlockOp`, `vars = BlockOp`).

### Internals (`web/internal/use-optimistic-resource.ts`)

- `result = useResource(resource, params)`; `base = result.pending ?
  resource.initialData : result.data`.
- `pending: { opId, vars, resolved }[]` in `useState`.
- `data = useMemo(() => pending.reduce((acc, op) => safeApply(acc, op.vars), base),
  [base, pending])`. `safeApply` wraps `apply` in try/catch and **drops** an op
  that throws (treat as "server already did this") — keeps replay total.
- Detect authoritative pushes by subscribing to the QueryCache for
  `queryKeyFor(resource.key, params)` (compare keys via the same `queryKeyFor`
  shape). On each push, run a confirmation pass: drop every `resolved` op that
  `isConfirmedBy(base, vars)` accepts (default: any push after resolve confirms).
- `dispatch(vars)`: `opId = crypto.randomUUID()`, append to `pending`, call
  `mutate(vars)`; on resolve mark `resolved`; on reject **remove the op**
  (overlay recomputes without it — that *is* the rollback; the cache was never
  mutated) and call `onError`.

### Confirmation strategies (implement in parts)

1. **Coarse (default, ships first):** clear a resolved op on the first push after
   it resolved. Matches `TreeList`'s "clear when server catches up." Risk: a
   coincidental unrelated push can clear one frame early (benign, sub-frame
   re-correct).
2. **Content-based (`isConfirmedBy`, ships second):** exact — the consumer checks
   the op's effect is present (e.g. `serverData.some(r => r.id === vars.newId)`).
   Recommended for the editor. Needs no protocol change.
3. **Server op-ack/op-log (future, only if precise multi-client convergence is
   needed):** server echoes the applied opId in the push. Out of scope.

## Implementation in parts

- **Part 1 — core primitive + validation adopter.** Build the hook (overlay/
  replay, coarse confirmation, error rollback). Prove it end-to-end by wiring
  **one low-risk existing surface that waits-for-refetch today** — recommended:
  **queue reorder** (`conversations/.../queue`, single `queueRanksResource`,
  single-field rank change, most visible latency) *or* page-tree drag-move.
  `apply` is a trivial array re-rank; `mutate` is the existing `fetchEndpoint`.
  Add unit tests for the replay reducer (multiple in-flight ops + interleaved
  pushes compose; error drops only the failed op; coincidental-push clearing).
- **Part 2 — content-based confirmation.** Add the `isConfirmedBy` path and (if
  desired) convert a second adopter (task-tree move) to exercise compound
  field changes (rank + parentId).
- **Editor adoption — separate sub-task** (see below): the block-ops reducer,
  the caret coordinator, intent resolution, client-minted UUIDs, and freezing
  text-autosave during in-flight ops all live there; this plan only delivers the
  primitive they consume.

## Files

- **Add** `plugins/primitives/plugins/optimistic-mutation/package.json`
- **Add** `plugins/primitives/plugins/optimistic-mutation/web/index.ts` (barrel + `definePlugin`)
- **Add** `plugins/primitives/plugins/optimistic-mutation/web/internal/use-optimistic-resource.ts`
- **Add** `plugins/primitives/plugins/optimistic-mutation/core/index.ts` (shared arg/result types, if shared)
- **Add** `plugins/primitives/plugins/optimistic-mutation/CLAUDE.md`
- **Modify** the Part-1 validation adopter (e.g. `conversations/.../queue/web/queue-view.tsx`)
  to dispatch through `useOptimisticResource` instead of bare `fetchEndpoint`.

Reuse, don't reinvent:
- `queryKeyFor(key, params)` — `@plugins/primitives/plugins/live-state/web` (exact key the WS path writes).
- `useResource` result `{ pending, data, error, refetch }` — same plugin.
- Precedent for "clear optimistic when server matches":
  `plugins/primitives/plugins/tree/web/internal/tree-list.tsx` (`optimisticExpanded`)
  and `plugins/primitives/plugins/sortable-list/web/internal/sortable-list.tsx` (`optimisticItems`).

## Boundary / plugin-architecture fit

- One barrel per runtime; cross-plugin imports via barrels only — satisfied.
- New primitive sits under the `primitives` umbrella (group of related
  primitives), consistent with the repo's "group related plugins under an
  umbrella" rule.
- No registry edits / codegen — primitive is consumed by direct barrel import.
- Run `./equin check plugin-boundaries` after adding.

## Risks

- **QueryCache subscription key match:** must compare against `queryKeyFor`'s
  exact shape (`[key]` vs `[key, params]`). Mitigation: reuse `queryKeyFor` +
  `JSON.stringify` compare.
- **Replay must be total:** a throwing `apply` would crash the overlay. Mitigation:
  `safeApply` drops the offending op.
- **Coarse confirmation early-clear:** acceptable for Part 1; Part 2's
  content-based path removes it for surfaces that care (the editor).
- **Op ordering:** `pending` is an ordered array replayed in enqueue order — this
  is what makes fast chained ops compose; preserve insertion order on updates.

## Verification

1. `./equin build`, open the validation surface at
   `http://<worktree>.localhost:9000`.
2. Scripted Playwright (`e2e/screenshot.mjs`): perform the mutation (drag reorder)
   and assert the UI updates **immediately** (before the WS round-trip), then
   stays correct after the push lands (no snap-back).
3. Throttle/offline the network and confirm: rapid repeated mutations compose
   (no flicker between them); a forced server error rolls the failed op back to
   server truth without disturbing other in-flight ops.
4. Unit tests on the replay reducer cover: N in-flight ops + interleaved pushes;
   error drops only the failed op; idempotent re-apply.

## Follow-up sub-task (out of scope here)

File a separate task: **"Block editor: authoritative client document model"** —
shared pure tree-op reducer in `editor/core/block-ops.ts` (split-with-children →
first child; **outdent reparents following siblings = Notion semantics, confirmed**;
backspace intent resolution), replayed identically on client (as this primitive's
`apply`) and server (retiring the 7 ad-hoc handlers); client-minted UUIDs; a
doc-level caret coordinator with px-column preservation + Left/Right across
blocks; and freezing text-autosave during in-flight structural ops. That task
*consumes* this primitive.

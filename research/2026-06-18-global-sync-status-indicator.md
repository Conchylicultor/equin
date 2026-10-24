# Generic, forced sync-status indicator for all optimistic surfaces

## Context

Optimistic updates (`useOptimisticResource`) and debounced autosave (`useEditableField`)
apply changes instantly, but the user gets **no signal that the change actually reached
the server**. Today the only feedback anywhere is `task-header`'s hand-rolled
`"Saving…"/"Saved"` text; every other optimistic/autosave surface (page blocks, page/story
titles, task description, agent name/prompt, conversation notes, code/equation blocks,
config staging, conversation queue) is silent. On a rejected save the situation is worse:
`useOptimisticResource` **silently removes** the op (rollback with only an `onError` toast)
and `useEditableField` **has no error state at all** — a failed save just vanishes from the
UI, which violates the project's "fail loudly" rule.

**Goal:** one generic primitive that (a) any optimistic surface feeds automatically, and
(b) is *structurally impossible to omit* — the author writes no indicator code, yet every
surface shows a Google-Keep-style cloud status (spinner → cloud-check → error+retry).

**Decisions already locked with the user:**
- Visual model = Google Keep: spinning icon while saving, cloud-check when saved, error
  icon (with retry) on failure.
- Scope/placement = **inside each surface's chrome** (one cloud per visible surface,
  including each floating window), *not* the global action bar — the action bar renders
  *above* `PaneSurfaceProvider` and can't see per-surface state, so a per-surface indicator
  there is impossible.

## Why "inside each surface" is the clean design

The universal per-surface wrapper is `TabSurface`
(`plugins/apps/web/components/tab-surface.tsx`), which renders every app inside
`PaneSurfaceProvider`. Mounting the sync-status store **and** indicator there means:
- The store Provider is an ancestor of all app content, so reporters deep inside (the
  optimistic/autosave hooks) write to it through plain React context — **no module-global
  registry, no `surface-id` keying needed**.
- It's mounted once for *every* surface with zero app opt-in → forced by construction.
- Each surface (incl. floating windows) gets its own isolated store via
  `defineScopedStore` (one store instance per Provider mount, exactly like `undo-redo`).

## Architecture

Two halves the consumer never controls = the "force":
1. **Reporting is unforgeable** — it lives *inside* `useOptimisticResource` /
   `useEditableField`. Use the primitive → you report.
2. **Rendering is unavoidable** — the indicator is mounted once in `TabSurface`, shared
   chrome no consumer owns.

```
TabSurface
  PaneSurfaceProvider
    SyncStatus.Provider                 ← per-surface scoped store (mounted here)
      {renderIsolated(Apps.App.id)}     ← app content; reporters deep inside write to store
      <SyncStatusIndicator/>            ← Pin overlay in a surface corner, reads aggregate
```

Dependency DAG (no cycles — sync-status imports none of its consumers):
`sync-status` → {`scoped-store`, `css` (Pin/Spinner/Text/icons), `tooltip`, `relative-time`}
`optimistic-mutation` → `sync-status`  ·  `editable-field` → `sync-status`  ·  `apps` → `sync-status`

## New primitive: `plugins/primitives/plugins/sync-status/web`

**Store** (`web/internal/store.ts`) — `defineScopedStore` (see
`plugins/primitives/plugins/scoped-store/web` API; canonical consumer is
`plugins/primitives/plugins/undo-redo/web/internal/store.ts`):

```ts
type SyncPhase = "idle" | "syncing" | "error";
interface SyncSource { phase: "syncing" | "error"; label?: string }   // only active sources kept
interface SyncStatusState {
  sources: Record<string, SyncSource>;   // keyed by reporter id (React useId)
  lastSavedAt: number | null;            // bumped when any source goes syncing → idle
}
```

Aggregate selector (`useSyncAggregate`), precedence **error > syncing > saved > idle**:
- any `error` → `{ kind: "error", labels }`
- else any `syncing` → `{ kind: "syncing" }`
- else `lastSavedAt != null` → `{ kind: "saved", at }`
- else `{ kind: "idle" }`  (render nothing)

Retry thunks are held per-source in a ref inside `useReportSync` (not in store state) so a
new closure each render never thrashes the store; the indicator pulls them imperatively.

**Reporter hook** (`web/internal/use-report-sync.ts`) — the generic, declarative API:

```ts
useReportSync({ phase: "idle" | "syncing" | "error", label?: string, retry?: () => void });
```

- Mints a stable id with `useId()`; a `useEffect` on `[phase,label]` updates its store entry;
  on unmount removes it. On `syncing → idle` the reducer bumps `lastSavedAt`.
- **No-Provider tolerance:** the store context default is a no-op sink, so the primitives
  stay usable outside a surface (unit tests, non-surface mounts) — `useReportSync` simply
  does nothing when no `SyncStatus.Provider` is above it.

**Provider** (`web/internal/provider.tsx`) — thin `SyncStatusStore.Provider` wrapper.

**Indicator** (`web/components/sync-status-indicator.tsx`) — a `Pin` (css `pin` primitive,
`to="top-right"` or bottom-right to dodge app toolbars) reading `useSyncAggregate`:

| aggregate | icon (react-icons/md — `no-lucide-react` safe) | label / action |
|---|---|---|
| `syncing` | `Spinner` (MdRefresh `animate-spin`, existing primitive) | "Saving…" |
| `saved`   | `MdCloudDone`, muted | "Saved" + `RelativeTime` in tooltip |
| `error`   | `MdCloudOff`, `destructive` | "Couldn't save {labels}" + **Retry** button → calls every error source's `retry()` |
| `idle`    | — | render nothing |

Add a short show-delay on `syncing` (mirror the `loading` primitive's ~120ms) so fast saves
don't flash the spinner.

**Barrel** (`web/index.ts`): export `useReportSync`, `SyncStatusProvider`,
`SyncStatusIndicator`, and types `SyncPhase` / `ReportSyncArgs`. Plus `CLAUDE.md`.

## Edits to existing code

1. **`plugins/apps/web/components/tab-surface.tsx`** — wrap the app render in
   `<SyncStatusProvider>` and add `<SyncStatusIndicator/>` as a sibling (inside
   `PaneSurfaceProvider`). This is the single forced mount point.

2. **`plugins/primitives/plugins/optimistic-mutation/web/internal/use-optimistic-resource.ts`**
   - Add optional `label?: string` to `UseOptimisticResourceArgs`.
   - **Retained failure + retry** (replaces silent `removeOp` on reject): on reject, roll
     back the overlay *and* record `{opId, vars}` in a new `failed` state; keep `onError`.
     Add `retry(opId)` (drops it from `failed`, re-`dispatch(vars)`). Extend
     `UseOptimisticResourceResult` with `failed` + `retry`.
   - Report inside the hook:
     `const phase = failed.length ? "error" : inFlight.length ? "syncing" : "idle"`
     `useReportSync({ phase, label, retry: failed.length ? retryAll : undefined })`.
   - Update barrel types + `optimistic-mutation/CLAUDE.md` (the reject-removes-op contract
     changes to reject-retains-as-failed).

3. **`plugins/primitives/plugins/editable-field/web/use-editable-field.ts`**
   - Add optional `label?: string` to `UseEditableFieldOptions`.
   - Add `isError` state: wrap `await onSaveRef.current(next)` in try/catch, set on reject,
     clear on next success; expose `isError` (and a `retry` that re-runs the save) in
     `EditableField`.
   - Report: `phase = isError ? "error" : isSaving ? "syncing" : "idle"`; `useReportSync(...)`.
   - Update `editable-field/CLAUDE.md`.

4. **`plugins/tasks/plugins/task-header/web/components/task-header.tsx`** — remove the now
   redundant inline `{titleField.isSaving ? "Saving…" : "Saved"}` `<Text>` (the universal
   indicator replaces it). Other surfaces gain the indicator automatically with no change.

5. **`./equin build`** — regenerates the web plugin registry for the new plugin.

## Enforcement ladder

- **Architectural (now):** reporting inside the only sanctioned optimistic/autosave
  primitives + indicator in the universal surface wrapper = impossible to have a surface
  using them without a visible status.
- **Optional (later, separate task):** a `no-adhoc-optimistic` lint rule (sibling of
  `no-adhoc-spacing`) banning ad-hoc `setQueryData`-prediction / `setState`+`fetch` outside
  the primitive, to close the "rolled my own" loophole. Out of scope here.

## Verification

1. `./equin build`, open `http://<worktree>.localhost:9000/pages/...`.
2. **Saving → saved:** with `bun e2e/screenshot.mjs`, type into a block; capture
   before/after — expect the spinner then `MdCloudDone`. Edit a page/story title and a task
   title/description (different apps) → same indicator appears, proving genericity.
3. **Per-surface isolation:** open two surfaces (floating-window placement); edit in one →
   only that surface's cloud reacts.
4. **Error + retry:** temporarily make a `mutate`/`onSave` reject (e.g. a throwaway throw in
   the page block endpoint call, or stop the server mid-save) → expect `MdCloudOff` +
   "Couldn't save" + Retry; clicking Retry re-sends and returns to saved. Revert the stub.
5. **Unit:** `bun test plugins/primitives/plugins/optimistic-mutation/web` — existing overlay
   tests still green; add a case for the failed/retry transition. Optionally a small
   `bun test` for the store reducer's `syncing → idle` `lastSavedAt` bump and aggregate
   precedence.

## Critical files

- NEW `plugins/primitives/plugins/sync-status/web/{index.ts,internal/store.ts,internal/use-report-sync.ts,internal/provider.tsx,components/sync-status-indicator.tsx}` + `CLAUDE.md`
- `plugins/apps/web/components/tab-surface.tsx`
- `plugins/primitives/plugins/optimistic-mutation/web/internal/use-optimistic-resource.ts` (+ barrel, CLAUDE.md)
- `plugins/primitives/plugins/editable-field/web/use-editable-field.ts` (+ barrel, CLAUDE.md)
- `plugins/tasks/plugins/task-header/web/components/task-header.tsx`
- Reference: `plugins/primitives/plugins/scoped-store/web`, `plugins/primitives/plugins/undo-redo/web/internal/{store.ts,provider.tsx}`, `plugins/primitives/plugins/css/plugins/{pin,spinner}/web`, `plugins/primitives/plugins/relative-time/web`

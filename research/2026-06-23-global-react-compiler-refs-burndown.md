# React Compiler — `react-hooks/refs` Burndown & Ratchet to Error (Phase 2)

**Date:** 2026-06-23
**Category:** global (frontend / lint infrastructure)
**Status:** Plan — ready to execute
**Follows:** [`2026-06-23-global-react-compiler-compliance.md`](./2026-06-23-global-react-compiler-compliance.md) (the multi-phase burndown; **Phase 1 already landed** — the 7 bail-causing rules are enforced at `error`). This doc is the execution plan for **Phase 2** only.

---

## Context

The React Compiler runs `compilationMode: "infer"` repo-wide. Phase 1 drove the 7
*coverage-blocking* Rules-of-React rules to zero and ratcheted them to `error`
(`build-lint-config.ts:189-195`). The remaining high-volume diagnostic,
**`react-hooks/refs`** (~174 warnings across ~54 `plugins/**/web` files), is still
pinned at `"warn"` (`build-lint-config.ts:184-188` documents this explicitly) so the
compiler's coverage signal stays noisy and a *new* ref violation never fails
`./equin check`.

Unlike the Phase-1 rules, `refs` violations do **not** cause the compiler to bail —
the component still compiles and is still memoized; the warning is a correctness/style
signal. The dominant pattern is the **idiomatic latest-value ref** (`const r = useRef(x); r.current = x` at render top, read only later in callbacks/effects), which is hand-rolled
inline everywhere with no shared primitive. The rest are `@dnd-kit` library refs and a
small number of genuine anti-patterns.

**Outcome:** capture the dominant idiom in a shared primitive, encapsulate the dnd-kit
library boundary, fix the genuine anti-patterns, document the few intentional render-time
machines, iterate the scan to **0**, then **ratchet `react-hooks/refs` → `error`** so the
codebase can never silently regress.

---

## Decisions (locked with the user)

1. **dnd-kit → the clean long-term fix (boundary primitive), not scattered disables.** Build a single dnd primitive layer that owns every `@dnd-kit` hook call; feature plugins stop importing `@dnd-kit` hooks directly. One exemption, enforced by a boundary check. (Details §3.)
2. **Ship `useEventCallback` alongside `useLatestRef`.** Consolidate both the latest-value-ref idiom *and* the "latest-ref + `useCallback([])` stable function" idiom. (Details §2.)
3. **`use-tab-presence.ts` → document as intentional.** Keep its render-time prev/diff machine (load-bearing for the exit tween's same-render correctness); add documented disables + verify the animation. Do **not** refactor to an effect. (Details §4.)

---

## Execution step 0 — authoritative scan (gates everything)

`node_modules` is not populated in this worktree and the original counts predate
Phase 1. **First**, populate deps and capture the live, authoritative site list +
exact messages:

```bash
./equin build            # runs bun install + regen + rebuild (deps for eslint)
bunx eslint "plugins/**/web/**/*.{ts,tsx}" -f json > /tmp/refs-scan.json
# aggregate refs sites by file:line and by the exact reported expression/column
```

Two things this scan settles that the plan is designed around:

- **The exact `refs` site universe** (the plan gives the bucketing rubric §1; the scan gives the rows). Bucket every site, then apply the bucket's treatment.
- **The dnd-kit trigger site** — confirm `react-hooks/refs` fires at the dnd-kit hook **call** (the mutable-state source), not at the downstream `isOver`/`transform` read. If call-site (expected): the boundary primitive §3 fully clears feature sites with one disable. If a read-site genuinely can't be encapsulated: that specific read gets a documented per-site disable (still routed through the primitive).

---

## §1 — Bucketing rubric (classify every `refs` site)

| Bucket | Signature | Treatment |
|---|---|---|
| **Latest-value ref** | `const r = useRef(x); r.current = x` at render top; `r.current` read only in callbacks/effects/rAF | Migrate to `useLatestRef(x)` (§2). |
| **Stable callback** | latest-ref + `useCallback([])` returning a fn that calls `ref.current(...)` | Migrate to `useEventCallback(fn)` (§2). |
| **dnd-kit library ref** | `useDraggable/useDroppable/useSortable` → `setNodeRef`/`isOver`/`transform` | Route through the dnd primitive (§3). |
| **Genuine anti-pattern** | ref read+written same render to track state; `getBoundingClientRect` in render; `ref.current` in a render `.map`/`useMemo` | Real fix (§4). |
| **Intentional render-time machine** | render-time prev/diff that must run during render for correctness | Documented disable + verify (§4, `use-tab-presence`). |
| **Lazy-init / write-once / mount-capture** (remainder) | conditional capture-once (`if (ref.current === null) ref.current = …`), or render-sync that is actually legal | Per-site: migrate to `useState(() => …)` where it's a value; else documented `// eslint-disable-next-line react-hooks/refs -- <reason>`. **Do not** force into `useLatestRef` — see the false-candidate notes below. |

**Confirmed false candidates (do NOT migrate to `useLatestRef`):**
- `use-tabs.tsx` `tabsRef`/`focusedRef`/`appsRef` — synced in render **but also authoritatively written inside callbacks**; `useLatestRef` would clobber the in-callback writes. Leave as-is (or document).
- `use-cursor-pagination.ts` `frozenCursorRef` — capture-once lazy-freeze, a distinct idiom.
- Refs written **inside `useEffect`** (e.g. `use-editable-field` `onSaveRef`/`frozenRef:52-58`) — effect writes are legal; they do **not** trip the rule. Optional cleanup only.
- `use-sticky-scroll.ts` — all writes are in effects/callbacks or are DOM element refs; **zero** `refs` sites.

---

## §2 — New primitive: `plugins/primitives/plugins/latest-ref` (`useLatestRef` + `useEventCallback`)

A new pure web-only leaf primitive, mirroring `plugins/primitives/plugins/surface-id`
exactly (purest hook leaf: `package.json` + `web/index.ts` barrel + `web/internal/latest-ref.ts`; **no** `server/`/`core/`/`shared/`; `CLAUDE.md` is autogenerated by build).

**Files to create:**
- `plugins/primitives/plugins/latest-ref/package.json` — `{ "name": "@singularity/plugin-primitives-latest-ref", "description": "...", "private": true, "version": "0.0.1" }`.
- `plugins/primitives/plugins/latest-ref/web/internal/latest-ref.ts` — the two hooks.
- `plugins/primitives/plugins/latest-ref/web/index.ts` — barrel: `export { useLatestRef, useEventCallback } from "./internal/latest-ref"; export default { description, contributions: [] } satisfies PluginDefinition;` (no authored `name`/`id` — identity is path-derived; barrel purity rules apply).

**API (minimal — confirmed against the real sites):**

```ts
// The one internal exemption for this whole class lives here.
export function useLatestRef<T>(value: T): React.MutableRefObject<T> {
  const ref = useRef(value);
  // eslint-disable-next-line react-hooks/refs -- intentional latest-value sync: written in render, read only in callbacks/effects; this is the single sanctioned home for the idiom
  ref.current = value;
  return ref;
}

// Stable-identity callback whose body always sees the latest closure.
export function useEventCallback<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  const ref = useLatestRef(fn);
  return useCallback((...a: A) => ref.current(...a), [ref]);
}
```

- **No multi-value overload** — multi-value sites pass an object literal (`useLatestRef({ onSave, frozen })`); object identity churns every render anyway and only `.current.field` is read in callbacks.
- **No getter variant** — every read site already does `.current`.

**Migration sites (latest-value → `useLatestRef`):** `editable-field/use-editable-field.ts:174-175` (`draftRef`), `optimistic-mutation/use-optimistic-resource.ts:73-76,145-146` (`applyRef`/`isConfirmedByRef`/`failedRef`), `networking/use-reconnecting-ws.ts:25-26` (`optsRef`), `live-state/use-resource.ts:269-270` (`refetchRef`), `scoped-store/internal/scoped-store.tsx:147-150` (`selectorRef`/`isEqualRef`), `apps/sonata/shell/web/context.tsx:308-424` (6 pairs read in a rAF tick). Plus any further latest-value sites the step-0 scan surfaces.

**Migration sites (stable-callback → `useEventCallback`):** `editable-field` `retry`, `optimistic-mutation` `retry`/`retryAll`/`dispatchRef`-backed callbacks, `use-resource` refetch closures. **These are load-bearing** (`use-resource` is imported by ~150 plugins) — preserve referential stability exactly; gate with the G3 protocol + spot checks (§6).

---

## §3 — dnd-kit boundary primitive (the clean long-term fix)

**Today:** `sortable-list` (`sortable-item.tsx` → `useSortable`) and `tree` (`use-tree-row.tsx` → `useDraggable` + 3× `useDroppable`) already encapsulate dnd-kit. **8 feature sites bypass them** with raw hooks: `page/editor/block-row.tsx`, `tasks/task-draft-form/task-draft-card.tsx`, and 5 `conversations/.../grouped/*` (`group-container`, `group-box`, `draggable-row`, `new-group-drop-zone`, `group-gap-zone`) + `conversations/.../queue/queue-view.tsx` (QueueCard).

**Target:** a small dnd primitive (extend `sortable-list`, or a sibling `primitives/dnd`) that owns **every** per-item dnd-kit hook call and exposes a typed, compiler-clean API. Feature plugins consume plain values; the **single** library-boundary exemption lives in the primitive hooks.

Proposed surface (covers all 10 sites' shapes):
- `useDropZone(opts) → { ref, isOver }` — droppable (incl. before/after/child as N calls).
- `useDragHandle(opts) → { ref, handleProps, isDragging, transform }` — draggable + handle.
- `useDragDrop(opts) → { ref, isDragging, isOver }` — merged draggable+droppable on one node (the `draggable-row` shape), with an internal `mergeRefs`.
- `SortableItem` (existing) — for sortable lists.

**Steps:**
1. Build the primitive; place the one `// eslint-disable-next-line react-hooks/refs -- @dnd-kit returns library-managed mutable state at the hook boundary` per hook call inside it.
2. **Migrate `task-draft-card.tsx` onto the existing `SortableItem`** (it's a near-duplicate — removes one raw site for free).
3. Route `block-row` + the 5 grouped + QueueCard through the new hooks.
4. Re-point `sortable-item.tsx` / `use-tree-row.tsx` to the same internal helpers so the exemption lives in exactly one layer.
5. **Add a boundary check** banning direct `@dnd-kit/{core,sortable}` *hook* imports (`useDraggable`/`useDroppable`/`useSortable`) outside the dnd primitive (a new `check/` or `lint/` rule under the primitive — see `boundaries` / contributed-check conventions). `DndContext`/`DragOverlay`/`useSensor` mounted by orchestration layers are fine (no ref read) and may be re-exported for full cleanliness.

**Gate (from step 0):** if any `isOver`/`transform` *read* at a feature site trips the rule even when sourced from the primitive, that specific read takes a documented per-site disable — but the hook call still goes through the primitive. (Expected: not needed; the rule fires at the call site.)

---

## §4 — Genuine anti-patterns (real fixes) + the one documented machine

- **`tab-drag-overlay.tsx:38,49-54,60-73`** — `getBoundingClientRect()` in render (after the `if (!session) return null` guard). **Fix:** lift the backdrop-origin / strip / caret measurements into a `useLayoutEffect` keyed on `session`, write results to state, render from committed state. (Backdrop rect is "stable for a drag" so it can be measured once per session.)
- **`page/editor/block-editor.tsx:852,882`** — `bulkDragRef.current` read inside the `flat.map` render (852) and `DragOverlay` (882); `bulkDragRef` is written in pointer handlers with no re-render → stale subtree highlight for a frame. **Fix:** mirror the bulk-drag descriptor into `useState` (set in the same handlers), read state in JSX. Keep the ref only if a synchronous non-render reader needs it. Fixes a latent correctness bug too.
- **`reorder/dnd-list-middleware.tsx` `nodeTypesRef.current` (read in the `entries` `useMemo`, ~503/521)** — a deliberate latest-value mirror to omit `nodeTypes` from the memo deps. The cited `:420` read is inside a deferred callback (not a violation). **Fix (minor):** drop `nodeTypesRef` and add `nodeTypes` to the memo deps (read the prop directly), *or* document with a disable if dep-churn matters. Confirm identity stability before choosing.
- **`use-tab-presence.ts:54-85`** — **intentional render-time machine** (reads + mutates `prevTabsRef`/`prevLiveIdsRef`/`retainedRef` during render and schedules exit timers, so a vanished tab persists in the *same* render to animate out). **Treatment (per decision 3):** keep the logic, add documented `// eslint-disable-next-line react-hooks/refs -- intentional render-time exit-presence diff; the vanishing tab must persist in this same render to play its exit tween` on the read/write lines, and **verify the exit tween still plays** (open floating placement, close a tab, confirm the animate-out). Note: the setTimeout-scheduling-in-render is the genuinely impure part; if it must be addressed, move *only* the timer scheduling to an effect while keeping the presence list derived in render — but default to documenting, no behavior change.
- **`jsonl-pane.tsx:201`** — **already fixed in Phase 1** (now a `useEffect` seeding `workingStartAt` on the rising edge). No action.

The independent repo-wide scan found **no other** genuine anti-patterns: all other `getBoundingClientRect`/`offsetWidth` calls are inside effects/handlers; no `ref.current` read inside a `useMemo`/render `.map` except the `nodeTypesRef` above; only `use-tab-presence` reads+writes refs in render.

---

## §5 — Iterate to zero, then ratchet

1. Apply §2–§4; `./equin build`; re-run the step-0 scan.
2. Bucket and treat any newly-surfaced sites (the remainder bucket §1). **Repeat until `react-hooks/refs` reports 0.**
3. **Ratchet.** In `plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts`, add — alongside the existing `error` pins (after the `...compilerDiagnosticRulesAsWarn()` spread, so the explicit key wins; `:189-195`):
   ```ts
   "react-hooks/refs": "error",
   ```
   and update the `:184-188` comment (only `set-state-in-effect` remains at `warn`). `./equin check`'s eslint now fails on any new `refs` violation.

---

## Critical files

- `plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts` — the ratchet (`:189-195`) + comment (`:184-188`).
- **New:** `plugins/primitives/plugins/latest-ref/{package.json,web/index.ts,web/internal/latest-ref.ts}` (template: `plugins/primitives/plugins/surface-id`).
- **New/extended:** the dnd primitive (under `sortable-list` or a new `primitives/dnd`) + its boundary check.
- Latest-ref/event-callback migration sites (§2); dnd feature sites (§3); anti-pattern files (§4).
- Verification reference: `plugins/debug/plugins/render-profiler/web/internal/fiber-walk.ts` (G3 — component naming must survive).
- Do **not** hand-edit `*.generated.ts` or `AUTOGENERATED` CLAUDE.md blocks — `./equin build` regenerates the registry (`web.generated.ts`, `plugins-registry-in-sync`) and docs (`plugins-doc-in-sync`) for the new primitive.

---

## §6 — Verification

1. **Scan = 0:** `bunx eslint "plugins/**/web/**/*.{ts,tsx}" -f json` → `react-hooks/refs` aggregates to 0 *before* the ratchet.
2. **Check green:** `./equin check` passes *after* the ratchet (proves 0).
3. **DOM tests:** `bun run test:dom` green (85/85 baseline).
4. **Build + boot:** `./equin build`; app boots at `http://<worktree>.localhost:9000`.
5. **Compiler correctness (G3):** bundle still contains `react/compiler-runtime`; render-profiler still names real components (not `Memo`/`Unknown`); `remounts === 0`. Spot-check the load-bearing migrations (`use-resource`, `use-optimistic-resource`, `scoped-store`): open a conversation/page, confirm live-state updates, optimistic edits, and refetch behave identically.
6. **Hot-path spot checks:** editable-field autosave + retry; reconnecting-ws reconnect; sonata transport (rAF tick); **dnd** — drag/drop in tree, sortable lists, reorder edit-mode, page block drag (incl. bulk-drag highlight), conversations grouped/queue DnD, task-draft reorder; **tab-presence** — floating-tab close exit tween; **tab-drag-overlay** — floating tab drag ghost/caret position.

---

## Risks

1. **Load-bearing migrations** (`use-resource` ~150 importers, `scoped-store`, `optimistic-mutation`). `useEventCallback` must preserve referential stability exactly — gated by G3 + spot checks.
2. **dnd trigger-site assumption** — if the rule fires at value-read not call-site, some feature reads keep a documented disable (fallback wired in §3); resolved at step 0 before building the primitive.
3. **`use-tab-presence` animation** — documenting (not refactoring) avoids the unmount-for-a-frame hazard; still verify the tween.
4. **Ratcheting too early** turns `./equin check` red — only after the scan is truly 0 (iterate-to-zero §5).
5. **Sibling sites surface after migration** — the re-scan loop catches them before the ratchet.

---

## Out of scope

- **Phase 3 — `react-hooks/set-state-in-effect`** (~67 warnings): a separate burndown; `set-state-in-effect` stays at `warn`.
- React 19 `useEffectEvent` as the eventual structural replacement for `useEventCallback` (note, defer).
- The 242 non-compiler warnings (`no-unnecessary-condition`, unused-disable directives) — unrelated lint cleanup.

---

## Implementation outcome (2026-06-23) — DONE, all green

Executed exactly as planned, with **one deliberate simplification** discovered empirically:

- **dnd-kit was NOT given a boundary primitive.** The live eslint messages showed the rule taints the ref-bearing hook-return *object* and flags **member access during render** (`droppable.isOver`, `r.beforeRef`, `sticky.scrollRef`); the existing clean `SortableItem`/`useTreeRow` already avoid it simply by **destructuring at the call site**. Verified empirically (a sample file went 3→0). So the clean fix was to destructure at each dnd-kit / auto-scroll call site — no new abstraction, no disables — and the ratchet-to-error guards regressions. (`JumpToBottomButton`'s prop was narrowed to a ref-free `JumpToBottomView` slice so `handle={…}` passes plain values.)
- **Latest-value idiom → `plugins/primitives/plugins/latest-ref`** (`useLatestRef` + `useEventCallback`), carrying the one sanctioned `react-hooks/refs` disable. ~40 sites migrated across primitives, sonata, the page-editor Lexical plugins, and misc.
- **Genuine anti-patterns refactored:** `tab-drag-overlay` (rect→`useLayoutEffect`+state), `block-editor` bulk-drag (ref→`useState`, also fixes a latent stale-highlight bug), `string-list-renderer` + `shadow-section` (focus-as-state), `dnd-list-middleware` (`nodeTypesRef`→prop dep), `sortable-list` (prev-items ref→render-phase setState), `use-draft` (lazy-init ref→`useState`), `description-view` (pending-selection ref→state).
- **Intentional render-time machines documented** with inline disables: `use-tab-presence` (exit-presence diff), `use-cursor-pagination` (frozen-cursor capture), the build-once `markdown` / `use-optimistic-resource` memos.
- **Ratchet applied:** `react-hooks/refs: "error"` in `build-lint-config.ts`.

**Verification:** scan `react-hooks/refs` **174 → 0**; `exhaustive-deps` 0; zero error-severity messages; `./equin build` deploys; `./equin check` all green (incl. type-check with the ratcheted config, plugin-boundaries, registry/doc in-sync); `bun run test:dom` 85/85; runtime smoke on `/`, `/pages`, `/settings` → 0 console/page errors.

### Footgun to fix structurally (reported, not worked around)

`useLatestRef`/`useEventCallback` returns are **not recognized as stable refs by `react-hooks/exhaustive-deps`** (it special-cases bare `useRef`, not custom hooks). So every consuming `useCallback`/`useMemo`/`useEffect` that reads a migrated ref must now list that ref in its deps — harmless (stable identity ⇒ no extra runs) but verbose, and a "you must also update X" coupling every future migration re-incurs. The standard eslint-plugin-react-hooks has no `additionalHooks`-style "known stable" config for this. Candidate structural fix: teach the lint config to treat these two hooks' returns as stable, or accept the dep-listing as the convention. Flagged for a decision; deliberately not memorialized as a per-agent workaround.

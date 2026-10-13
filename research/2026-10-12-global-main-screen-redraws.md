# Main screen: stop redrawing the conversations sidebar five times (plan)

Track: Cold start performance (page block-31faa75d-…), task [Main screen].
Findings it builds on: `research/2026-10-11-global-client-lazy-plugins.md`, section
"Findings: the main-thread burst after first data".

## Context

On a cold `/agents` load the main screen appears ~2 s after the first data, with the main
thread busy the whole time. The React profile: ~110 commits, 56 k fibers, of which ~52 k in
five commits that each render the whole conversations sidebar (~57 rows × ~200 fibers).

Every cost is `rate × cost`. Here **cost** = one whole-sidebar render (~12–14 k fibers,
because no row is a memo boundary) and **rate** = 5 per boot (1 legitimate mount + 4 redraws,
each with its own origin). Both axes are fixed; neither alone closes the gap.

## The two questions

### 1. "Adding plugins redraws only the parts that read what changed" — can the API enforce it?

Yes, and cleanly, because there is exactly one read substrate:

- Today `PluginProvider` (`web-sdk/core/context.tsx:96`) rebuilds `{plugins, contributions,
  bySlot}` in a `useMemo([plugins])` on every append: every contribution re-spread (new
  identity), every slot array new, and the context value new. Every reader does
  `useContext(PluginRuntimeContext)`, so **every slot reader in the app re-renders on every
  batch** (1 priority + ~7 deferred batches), whether or not its slot changed. Reads funnel
  through `slots.ts:58` (`useContributions`), the four `render-slot.tsx` constructors, and 9
  files that read `ctx.bySlot` directly.
- Fix at rung 1 (inexpressible): the context carries a **stable registry store**, never a
  per-append value. The only read is per slot —
  `useSyncExternalStore(cb => registry.subscribe(slot, cb), () => registry.get(slot))`.
  `PluginRuntime.bySlot` / `.contributions` leave the public API, so "subscribe to all
  plugins" has no spelling. The ~420 call sites keep their API (`useContributions`,
  `.Render`, …); the 9 direct readers migrate to the per-slot read.
- Identity: contributions stamped once (WeakMap by contribution object); on append, each
  slot's new list is compared element-wise to the old and **the old array is kept when
  equal**, so only slots whose contributor list really changed notify.
- Two hidden "everything changed" sources must be closed too, or the store would still
  notify broadly:
  - `reorder/web/internal/config-registrations.ts:32` empties and refills
    `reorderConfigContributions` with **new** `ConfigV2.WebRegister` objects on every
    declaration pass → the config registry slot (read by every `useConfig`) looks changed on
    every append. Keep one object per descriptor (cache by descriptor), push only new ones.
  - `deferred-load-store`: `useDeferredLoadState()` returns a new snapshot each batch;
    consumers that only need `deferredComplete` get selector hooks (precedent:
    `useHasLoadErrorUnder`).
- `App` stops holding the plugin list in `useState`: it calls `registry.append(batch)`. No
  App re-render; the route-content commit is just the readers of changed slots (the pane
  router reading `Pane.Register`, etc.). `markRouteContentAtNextCommit` still applies.
- This is the substrate lazy plugins need (a slot's contributors arriving later, notifying
  only that slot's readers), so it is not throwaway.

**Would it fix the issue?** Partly, and only redraw #4. It removes the whole-app redraw on
the route-content commit (~12.8 k fibers) and the same whole-app redraw on each of the ~7
deferred batches that follow (they compete for the same main thread). It does nothing for
redraws #1–#3: those are not plugin appends. Expect roughly a quarter of the burst's fibers,
not the 2 s.

### 2. Why five redraws in the first place?

Each has its own origin; per the stopping gates (legitimacy):

| # | Redraw | Origin | Legitimate at boot? | Origin fix |
|---|---|---|---|---|
| 0 | First draw | first data | yes | — |
| 1 | `Region` / `MergedDataView` (useSyncExternalStore) | Most likely **not config** (config is `boot-and-keep`): the focused-app store is `undefined` until `TabsProvider` publishes it from a `useEffect` (`apps-core/tabs/web/internal/use-tabs.tsx`, `focused-app-store.ts:31`), so `useAppSettingsScope` sees `undefined → "agents"` after first commit — a value knowable at first render from the URL | no | publish the focused app before first render (initialise the store from the URL synchronously); confirm with the profile first |
| 2 | `DndContext` (useReducer) | dnd-kit: every sortable row's `useDroppable` effect dispatches `RegisterDroppable` → new context value → every `useSortable` row re-renders. Nothing is being dragged at boot | no | rows become sortable on drag intent (pointer-down on a ranked row mounts the sortable layer), not at mount |
| 3 | `QueueSource` (useState ×3) | read waterfall: `queueRanks` is keyed on the live id set from `conversationsActive` and not preloaded ("an id set has no default tuple") → one extra round trip and one extra render; plus the set-during-render `lastGood` bounce | the data is, the extra pass is not | ranks arrive with the boot snapshot (preload the tuple derived from the boot active set), so the queue settles in one render |
| 4 | `App useState #0` | plugin append re-renders every slot reader | no | question 1 |

And the **amplifier** that turns each of them into a whole-list render: no row is a memo
boundary. `ListView` builds rows inline in `.map` closures (`renderRow` → `ManualOrderRow` →
`Row` → `SidebarConversationItem`), which the React Compiler cannot memoize per item, and
`classifyQueue` / `useQueueRows` re-spread every row into a new object on every recompute
(throwing away the per-row identity `useLive` already preserves). This one matters beyond
boot: at runtime, one conversation changing re-renders all 57 rows.

So: fix the amplifier (cost axis, a boundary invariant for every list) **and** the origins
(rate axis). Either alone leaves most of it.

## Plan (one session, one branch, measured step by step)

0. **Baseline**: `cold-start.ts --iterations 5`, `--iterations 5 --busy 3`, and
   `--react-profile` (unminified) on this branch before any change. Record first data, main
   screen, commits, fibers per top commit. Extend the profile's initiator output to name the
   store/hook whose snapshot changed if #1 cannot be attributed with certainty.
1. **Framework — per-slot registry store** (`web-sdk/core/context.tsx`, `slots.ts`,
   `web-core/web/App.tsx`, `slot-render/web/internal/render-slot.tsx`, the 9 direct readers:
   `config_v2/web/internal/{use-store-path,use-config-registrations,use-set-config}.ts`,
   `app-shell/.../app-shell-layout.tsx`, `data-view/web/{cell-slot,cell-editor-slot,column-config-slot}.ts`,
   `data-view/web/internal/use-field-identities.ts`, `reorder/plugins/node-types/.../use-node-types.ts`).
   Plus stable `reorderConfigContributions` and selector hooks on `deferred-load-store`.
   Keep `contributionsOf`'s first-read mark (the benchmark reads it); keep raw/clean index
   alignment for `Dispatch`; keep the `_pluginId` stamp (reorder keys on it).
   Test: a web-sdk jsdom test — appending a batch that contributes to slot A re-renders a
   reader of A and not a reader of B; equal lists keep array identity.
2. **List rows are memo boundaries** (`data-view/plugins/list/web/components/list-view.tsx`):
   extract a memoized row component taking the row object and stable props;
   `RankReorderProvider` gets a stable `items` and callbacks. `useQueueRows` / `classifyQueue`
   keep the previous row object per id when its fields are unchanged.
3. **Origins**: (a) focused-app store initialised from the URL before first render;
   (b) sortable layer activated on drag intent (`primitives/rank-reorder`); (c) queue ranks in
   the boot snapshot for the boot active set, `lastGood` bounce removed.
4. **OverflowPanel** (`adaptive-bar/web/internal/overflow-panel.tsx:60`):
   `whileElementsMounted: open ? autoUpdate : undefined`.

After each step: `--react-profile` (fibers / commits) and after steps 1, 2 and 3 a cold
`--iterations 5` (+ `--busy 3` at the end). Before/after table on the track page; tick the
sub-tasks; follow-up task with the page id and the instructions block id.

## Verification

- `./singularity test plugins/framework/plugins/web-sdk plugins/primitives/plugins/data-view plugins/conversations` (new tests for slot-scoped notify and row identity).
- `./singularity build` (all checks) then the benchmark runs above; target: the five big
  commits gone (one ~12 k mount, everything else in the hundreds), main screen well under 1 s
  after first data.
- Manual: drag-reorder in the sidebar still works (sortable activation), plugin hot paths
  (theme switch, config edit) still update their readers.

## Risks

- Ordering: a late plugin can land in the middle of a slot's topo order — handled because the
  list is recomputed and compared, not appended.
- Tests that mount `PluginProvider` with a fixed list keep working (the provider builds the
  store once from its prop).
- Drag-intent activation must not lose the first pointer-move of a drag (activate on
  pointer-down, before the sensor's distance threshold).

## Results (2026-10-13)

Built as planned, with these differences:

- **Step 1, the per-slot registry** (`web-sdk/core/registry.ts`). It is one stable object; `append(batch)` re-derives each slot's list and keeps the old (frozen) array when the list is equal element-wise. Only readers of changed slots are notified. The one read is `useRawContributions(slot)`, a `useSyncExternalStore` on one slot. `PluginRuntimeContext`, `contributionsOf` and `useDeferredLoadState` are gone from the barrel, so a whole-runtime read has no spelling. Contribution lists are now typed `readonly`, because they are shared and frozen.
  - Two contributors re-created their objects on every append and needed a per-key cache: reorder's `ConfigV2.WebRegister` and pane header titles.
- **Step 2, rows.** Each list row is a memoized `ListEntry` with stable shared config. The queue reuses row objects whose fields are unchanged (`reuse-rows.ts`). The rank-reorder provider's sensors, ids and callbacks are stable.
- **3a, the focused app.** It could not be published before first render: `AppsLayout` and `ThemeInjector` read it before `TabsProvider` renders. Instead, `useActiveApp` reads the resolved app id as one snapshot. It re-renders only when the answer changes, so neither the boot publish nor same-app navigations re-render it.
- **3b, drag on intent: not done.** dnd-kit cannot start a drag from a pointer-down it did not see. Instead, rows are memoized, so registration re-renders only the thin `ManualOrderRow` wrapper, never the row content.
- **3c, ranks in the boot snapshot.** `serveCollection(c, { preloadRows: { idsOf } })` is a new server option. It preloads the `:rows` tuple for the ids of another preloaded `all` collection.
- **Step 4, the overflow panel.** Positioning stops only when both changes are made: no `autoUpdate` while closed, and no reference element while closed. Floating UI positions once on mount when both elements are set, and each row has a closed panel, so that is 60 commits.
- **Found during measurement: per-row live reads.** Each of ~60 sidebar rows makes 4 `useLiveRow` reads, so 240 subscriptions, 240 sub-acks and, through React Query's per-batch `setTimeout(0)`, 240 commits. `primitives/live-state` now installs a coalescing notify scheduler (`coalesced-notify.ts`), so a burst of landings is one commit. The origin, one subscription per row, is left for a follow-up: a shared id-set read per `:rows` key, plus a boot preload.

### Measurements

Fair A/B: the unchanged build (a second checkout at the base commit, built and deployed as `redraws-base`) and this branch, run alternately. `/agents`, cold, empty browser cache, medians.

| | calm before | calm after | `--busy 3` before | `--busy 3` after |
|---|---|---|---|---|
| page request → main screen | 4.63 s | **4.30 s** | 5.59 s | **5.04 s** |
| page request → first data | 2.42 s | 2.89 s | 3.09 s | 3.51 s |
| first data → main screen | 2.20 s | **1.38 s** | 2.52 s | **1.55 s** |
| React commits in that window | 116 | **17** | 116 | **20** |

Calm: 8 runs per side, load average 4–6. Busy: 6 runs per side, load average 6–11.

- **Components rendered, profiler install → main screen:** about 60,000 → about 7,000. The four 12–15 k whole-sidebar commits are gone.
- **First data is ~0.45 s later because the first frame is fuller.** Before, the sidebar rows mounted after first data, in the 14.8 k `QueueSource` commit, once the ranks round trip landed. Now the ranks are in the boot snapshot, so the first data commit already draws the rows. The CPU profile agrees: load-plugins end → first data went 0.56 → 1.02 s, and first data → main screen went 2.31 → 1.39 s, with react-dom self time 722 → 417 ms.
- **What remains in first data → main screen (~1.4 s busy).** It is no longer whole-tree renders:
  - react-dom 0.42 s
  - live-state + network/live + networking about 0.45 s inclusive: the 240 per-row subscriptions
  - element-size / latest-ref 0.14–0.15 s
  - config 0.1 s, reorder 0.09 s, adaptive-bar 0.08 s

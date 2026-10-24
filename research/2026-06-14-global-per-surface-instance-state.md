# Per-surface-instance app state (generic primitive) + Sonata migration

**Date:** 2026-06-14
**Category:** global (primitives + apps + shortcuts + sonata)
**Status:** Plan — awaiting approval

## Context

The new desktop multi-window arrangement and the keep-alive tabs arrangement both mount
**multiple instances of the same app simultaneously** — each `TabSurface`
(`plugins/apps/web/components/tab-surface.tsx`) mounts its own `SonataProvider` tree. But
Sonata stores cross-cutting state in **module-level singletons**, which are process-global,
so every instance shares them. Observable bug: with two Sonata windows open, pressing
**Space in window A toggles window B**, and **only one song ever plays**.

Each store carries a now-false comment: *"one Sonata app mounts at a time, so a singleton is
correct."* That invariant — *"`AppsLayout` mounts only the active app"* — was silently
relaxed by surface-arrangement, but the abstractions that depended on it were never updated.
Four offending stores:

| Store | File | State |
|---|---|---|
| transport | `plugins/apps/plugins/sonata/plugins/shell/web/transport-store.ts` | `let current` — a command bus bridging the global window-keydown shortcut handler into React |
| cursor | `plugins/apps/plugins/sonata/plugins/shell/web/cursor-store.ts` | `let cursorBeat` + listeners; `useCursorBeat`/`useCursorSelector` (60fps no-re-render reads) |
| audio | `plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web/audio-store.ts` | `let state` (volume/status/loadError) + `lastNonZeroVolume` |
| key-mode | `plugins/apps/plugins/sonata/plugins/shell/web/key-mode-store.ts` | `let keyAutoDetect` |

**Goal & intended outcome.** Make app state per-surface-instance *by default*, via a generic,
reusable primitive — not a Sonata one-off. Migrate all four Sonata stores onto it, fix the
keyboard focus-routing that the transport bus papered over, and add a lint rule so the
module-global anti-pattern can't recur in app code. Two product decisions (confirmed with the
user): **(1)** include surface-focus scoping for shortcuts so "Space in A toggles B" is fully
fixed; **(2)** two open Sonata windows play **independently/simultaneously** (true isolation).

**Key insight.** Because each surface already mounts its own React provider subtree, a store
created *inside* a provider via `useState(() => createStore())` is automatically per-instance —
React component identity does the scoping for free. No tab-id keying is needed for the stores
themselves. An explicit surface id is needed only for **shortcut focus routing**, because the
global keydown listener runs outside any subtree.

## Design

### 1. New generic primitive: `defineScopedStore`

New plugin `plugins/primitives/plugins/scoped-store/`. A module-level factory returns a stable
*handle*; the *state* is created per `<Provider>` mount. This is the sanctioned replacement for
the ad-hoc `let x; const listeners = new Set()` + `useSyncExternalStore` pattern repeated all
over the repo (cursor-store, `reorder/web/internal/edit-mode-store.ts`,
`surface-arrangement/.../use-window-geometry.ts`, …).

```ts
export interface ScopedStore<S> {
  getState(): S;
  setState(next: S | ((prev: S) => S), opts?: { meta?: unknown }): void;
  subscribe(listener: (meta?: unknown) => void): () => void;
}
export interface ScopedStoreHandle<S> {
  Provider: (props: { children: ReactNode; initial?: S | (() => S) }) => ReactNode;
  useStoreApi(): ScopedStore<S>;                              // imperative, in-subtree (rAF loop, sync reads)
  useStore(): S;                                              // reactive whole-state
  useSelector<T>(selector: (s: S) => T, deps: DependencyList,
                 isEqual?: (a: T, b: T) => boolean): T;       // generalizes useCursorSelector
}
export function defineScopedStore<S>(defaultInitial: S | (() => S)): ScopedStoreHandle<S>;
```

- `Provider` creates the store once with `useState(() => createStore(initial ?? defaultInitial))`
  and exposes it via a React context → per-mount = per-surface.
- `setState` bails on `Object.is`-equal state (stable snapshot identity, no SES loop) and
  forwards an optional `meta` channel to subscribers — this generalizes cursor-store's
  synchronous `{ seek }` flag.
- `useSelector` is a verbatim port of `cursor-store.ts:96-132` (selectorRef/isEqualRef/cacheRef/
  depsRef + `useSyncExternalStore`), with the cache keyed on `getState()` identity instead of a
  bespoke `beat` primitive.

**Files:** `web/index.ts` (barrel), `web/internal/scoped-store.tsx`, `web/__tests__/scoped-store.test.tsx`
(jsdom: selector bailout, deps invalidation, per-Provider isolation — port `cursor-store.test.ts`),
`CLAUDE.md`. Mirror template: `plugins/primitives/plugins/pane/web/pane.ts` `createPaneStore`.

### 2. Migrate Sonata's four stores

Keep the **exact existing exported hook/function names** as thin adapters from the **shell
barrel** (`plugins/apps/plugins/sonata/plugins/shell/web/index.ts`) so the ~7 cross-plugin
consumer files don't change and `plugins-doc-in-sync` churn is minimal.

- **cursor** → `cursorStore = defineScopedStore<{ beat: number }>({ beat: 0 })` in shell.
  `SonataProvider` renders `<cursorStore.Provider>` (innermost — the rAF loop writes it).
  - `useCursorBeat()` → `cursorStore.useSelector(s => s.beat, [])`; `useCursorSelector(sel, deps, eq)`
    → adapter over `useSelector`. Hook-only consumers unchanged: `piano-keyboard`, `piano-roll`,
    `progress-bar`, `chord-readout`, `key-chip`, `key-readout`, `playback-controls`.
  - **Hard part:** three *synchronous* readers of `getCursorBeat()` outside React
    (`context.tsx` rAF loop, `audio-engine.tsx:231` scheduler, `piano-roll.tsx` scene/subscribe).
    The module global made this trivial; per-surface forces capturing `cursorStore.useStoreApi()`
    in a ref (one capture suffices — the store is stable for the surface's life). All three
    already live inside `SonataProvider`. `setCursorBeat(beat,{seek})` →
    `setState(p => p.beat === beat && !seek ? p : { beat }, { meta: { seek } })`.
- **key-mode** → `keyModeStore = defineScopedStore<{ autoDetect: boolean }>({ autoDetect: false })`
  in shell; Provider in `SonataProvider`. Adapters keep `getKeyAutoDetect`/`setKeyAutoDetect`/
  `subscribeKeyAutoDetect`/`useKeyAutoDetect`. Writers (`key-mode-observer.tsx`, `key-readout.tsx`)
  and reader (`context.tsx:237`) are all inside `SonataProvider` → use the hook form.
- **audio** → `audioStore = defineScopedStore<AudioState>(...)` in the **engine** plugin;
  fold `lastNonZeroVolume` into `AudioState` (per-surface). Consumers `audio-engine.tsx` and
  `volume-control.tsx` switch to `audioStore.useStore()`/`useStoreApi()`. Placement: see §4.
- **transport** → **deleted entirely** (see §3).

### 3. Surface-focus scoping for shortcuts (fixes "Space in A toggles B")

The single global `ShortcutManager` (`plugins/primitives/plugins/shortcuts/web/internal/
shortcut-manager.tsx`) has no notion of focus. Add it:

1. **Stable surface id.** Add `PaneSurfaceIdContext` + `useSurfaceTabId()` to
   `plugins/primitives/plugins/pane/web/pane.ts` (mirror `PaneSurfaceAppContext`); pass
   `surfaceId={tab.tabId}` from `tab-surface.tsx`.
2. **Focused-surface signal readable outside React.** New
   `shortcuts/web/internal/focused-surface.ts`: `get/setFocusedSurfaceId()` (a legitimately
   global single value — exactly one focused surface per page; push-based, not polled).
   Wire `setFocusedSurfaceId(focusedTabId)` from `TabsProvider` (`apps/web/internal/use-tabs.tsx`)
   via a one-line effect on `focusedTabId`.
3. **`surfaceId` on shortcuts + manager filter.** Add optional `surfaceId?: string` to
   `ShortcutDescriptor`; in `handleKeyDown`, after the `when` guard:
   `if (s.surfaceId !== undefined && s.surfaceId !== getFocusedSurfaceId()) continue;`
   A surface-less shortcut stays always-eligible (global, unchanged).
4. **Dynamic, auto-tagged registration.** `defineShortcut` is a static contribution and can't
   read context. Add a `useSurfaceShortcuts(descriptors)` hook + a dynamic registry merged into
   `ShortcutManager`'s active set; the hook reads `useSurfaceTabId()`, tags each descriptor with
   `surfaceId`, and suffixes ids with the surface id (avoids the dev duplicate-combo warning and
   registry collisions across open windows). Static global shortcuts keep their existing path
   byte-identical.
5. **Migrate Sonata controls.** Replace the static `transportShortcuts` array +
   `whenSonataActive` guard with a per-surface `Sonata.Effect` component that reads `useSonata()`
   (this surface's verbs) and calls `useSurfaceShortcuts([...])`, gated on `currentSongId !== null`
   (the explicit replacement for the implicit "transport bus empty on library" gate).
   `seek-hold-controller.tsx` (already a per-surface `Sonata.Effect`) reads `useSonata()` verbs
   via refs and guards its raw window listeners with
   `if (surfaceIdRef !== getFocusedSurfaceId()) return;` + the song-open gate.
   **Delete `transport-store.ts`**, its shell-barrel exports, and the `publishSonataTransport`
   effect in `library/web/panes.tsx:143-156`.

Independent simultaneous playback (decision 2) falls out for free: each surface already has its
own `SonataProvider` → own rAF loop → own (now per-surface) cursor + audio stores → own
`AudioContext`. Focus scoping governs only *keyboard* routing.

### 4. Audio-store Provider placement (cross-plugin boundary)

Both audio consumers — `AudioEngine` (`Sonata.Effect`) and `VolumeControl` (`SonataToolbar.End`)
— already render inside `SonataProvider`'s subtree but in different slot branches, so they need
one shared per-surface Provider above both. Constraint: `engine` imports `shell`, so **shell must
not import `engine`** (no cycle) — shell can't render the engine's Provider directly.

**DECISION (locked): a wrapper slot.** Add `defineWrapperSlot` to
`plugins/primitives/plugins/slot-render/` (folds contributions outside-in around shared
`children`; no such "wrapper contribution" primitive exists today). Shell defines
`Sonata.SurfaceProvider`; `SonataProvider` renders `<Sonata.SurfaceProvider.Wrap>{children}</…>`.
Engine contributes its `AudioProvider`. This is the *generic* answer ("any plugin can inject a
per-surface provider") and aligns with the "by default" goal. During implementation, confirm the
build facet/docgen pipeline discovers the new slot kind (mirror how `defineMountSlot`/
`defineDispatchSlot` register their facets); this is the main integration risk for this piece.

*(Alternative considered and rejected: a leaf plugin holding the `defineScopedStore` handle that
both shell and engine import, with shell rendering `<audioStore.Provider>` directly. Lighter — no
new primitive — but not generic and couples shell to the store's existence. Rejected in favor of
the reusable wrapper slot.)*

### 5. Enforcement: lint rule (not a build-check)

Add contributed ESLint rule `no-module-mutable-store` to the existing `plugins/apps/lint/`
barrel (template: `plugins/primitives/plugins/radius/lint/no-adhoc-radius.ts`). AST-precise,
editor-integrated, with a per-site escape hatch — preferred over a `grepCode` check.

- Self-scope: `if (!context.filename.includes("/plugins/apps/plugins/")) return {}`.
- Flag a module-level (`node.parent.type === "Program"`) `let`/`var` whose file also constructs a
  listener `Set` / uses `useSyncExternalStore` (the external-store tell) — narrow to avoid false
  positives. Message points to `defineScopedStore`.
- `liveStore`/`tabsNavigator`/`use-window-geometry` live in `apps/web/internal` (outside
  `plugins/apps/plugins/` surface trees) → out of scope, no exemption needed. `reorder/edit-mode`
  is the same anti-pattern but out of scope — `add_task` a follow-up rather than gold-plating.

## Files

**New:** `primitives/scoped-store/{web/index.ts,web/internal/scoped-store.tsx,web/__tests__/…,CLAUDE.md}`;
`shortcuts/web/internal/{focused-surface.ts,use-scoped-shortcut.tsx}`;
`slot-render` `defineWrapperSlot` (or the leaf audio plugin);
`apps/lint/no-module-mutable-store.ts`; `sonata/.../controls/web/components/transport-shortcuts.tsx`;
`engine/web/components/audio-provider.tsx`.

**Modified:** `primitives/pane/web/pane.ts` (+`useSurfaceTabId`); `apps/web/components/tab-surface.tsx`;
`apps/web/internal/use-tabs.tsx` (focus signal); `shortcuts/web/internal/{types.ts,shortcut-manager.tsx}`,
`shortcuts/web/index.ts`; `shortcuts` `define-shortcut.ts`; `apps/lint/index.ts`;
sonata shell `index.ts`, `context.tsx`, `cursor-store.ts`, `key-mode-store.ts` (rewritten as
adapters), `slots.ts`, `components/sonata-layout.tsx`; sonata `controls/web/{shortcuts.ts,
seek-hold-controller.tsx}`; `library/web/panes.tsx`; engine `audio-store.ts`,
`components/{audio-engine.tsx,volume-control.tsx}`, `web/index.ts`; key-mode/key-readout writers.
**Deleted:** `sonata/.../shell/web/transport-store.ts`. Docs: `scoped-store/CLAUDE.md`,
`shortcuts/CLAUDE.md`, sonata `shell/`, `engine/`, `controls/` CLAUDE.md.

## Implementation order

1. Build `scoped-store` primitive + jsdom test → `./equin build`.
2. `useSurfaceTabId` in pane + `tab-surface.tsx`.
3. Focused-surface signal + manager filter + `surfaceId` + dynamic registry + `useSurfaceShortcuts`;
   wire `setFocusedSurfaceId` from `TabsProvider`.
4. `defineWrapperSlot` + `Sonata.SurfaceProvider` (or decide leaf-plugin).
5. Migrate cursor-store (ref pattern for the 3 synchronous readers).
6. Migrate key-mode-store.
7. Migrate audio-store into engine via the chosen Provider mechanism.
8. Migrate Sonata shortcuts + seek-hold to per-instance/focus-scoped; **delete transport-store**;
   remove publish effect.
9. Add lint rule.
10. Docs + `./equin build` + `./equin check` (incl. `plugin-boundaries`).

## Verification (end-to-end)

Scripted Playwright (`e2e/screenshot.mjs`) against `http://<worktree>.localhost:9000`:
1. Switch surface arrangement to **desktop**; open Sonata in two windows, each a different song.
2. **Independent playback:** play A, leave B paused → only A's cursor/progress advances; both
   produce sound when both play (two `AudioContext`s).
3. **Focus A, press Space** → only A toggles; B unchanged. Then focus B, Space → only B toggles.
   (Core "Space in A toggles B" fix.)
4. **Hold ArrowRight in A** → only A scrubs (seek-hold focus gate).
5. **A's volume slider / mute** → only A's audio changes.
6. **Key auto-detect toggle in A** → only A re-infers.
7. `./equin check` green; the new lint rule would fail on a reintroduced module store.

## Risks / flags

- **Synchronous cursor reads** are the timing-sensitive crux (rAF loop, audio anchor at play
  instant, piano-roll scene). Mechanical but must keep reading the *current* beat — verify after
  the ref conversion.
- **Cross-plugin barrel exports:** cursor/key-mode handles must be re-exported from the shell
  barrel under the *same names* (7+ consumers) to minimize churn and keep doc-sync green.
- **New boundary edges:** `apps → shortcuts` (focus writer) and `shortcuts → pane`
  (`useSurfaceTabId`). Neither cycles (verified). Run `./equin check plugin-boundaries`.
- **`SonataProvider` wraps library + player**, so the implicit "player on screen" gate from the
  transport bus is gone — re-create it explicitly via `currentSongId !== null` in the per-surface
  shortcut/seek-hold contributions. Document in `controls/CLAUDE.md`.
- **Dynamic shortcut registry** is a new path in the load-bearing `shortcuts` primitive — keep the
  static path byte-identical; suffix ids with surfaceId to avoid duplicate-combo warnings.
- **`defineWrapperSlot`** is a new slot-render primitive — confirm build facet/docgen discovers it,
  or use the leaf-plugin fallback.
- **Out of scope (don't gold-plate):** `reorder/edit-mode-store`, `use-window-geometry` are the
  same anti-pattern outside app surface trees — `add_task` a follow-up to widen the lint rule.

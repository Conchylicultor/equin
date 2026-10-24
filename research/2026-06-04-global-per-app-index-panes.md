# Per-app index/landing panes

## Context

The `welcome` pane bleeds into Sonata: navigating to `/sonata` shows the
agent-manager welcome surface as an opaque overlay instead of the piano roll.

Root cause — **two distinct concepts are conflated inside the shared chain
store**:

1. **The opened chain** — what the user explicitly navigated to / opened
   (URL-derived). At an app's bare root this is *empty*.
2. **The index / landing pane** — what fills an app's main area when nothing
   is open. This is a per-app, main-area-renderer concern.

`parseUrl` (`plugins/primitives/plugins/pane/web/pane.ts:304-321`) injects a
default index pane into the chain whenever the URL is empty, picking the first
**unscoped** root-segment pane — `welcomePane`
(`plugins/welcome/web/panes.tsx:4-8`, no `appPath`). That injected chain is
then consumed by **both** renderers that read the chain store:

- `MillerColumns` as an app's main area (agent-manager, pages, …) — *wants* an
  index pane. ✓
- `PaneOverlayHost` (Sonata's bespoke layout, `sonata-layout.tsx:188`) — an
  empty URL must mean "no overlay", but it instead receives the welcome index
  pane and renders it `absolute inset-0` over the piano roll. ✗

`welcomePane` is also registered as the *global* fallback, so it is the
implicit default for every app, not just the manager (`debug`/`forge`/`deploy`/
`file-explorer`/`workflows` all silently inherit it at their bare root; only
`pages` scopes its own via `appPath: "/pages"`).

### Outcome

Separate the two concepts (option A — keep `appPath` on the pane, the existing
`pages` precedent; the pane primitive stays a pure, path-keyed primitive with no
coupling to the `apps` plugin):

- The opened chain is purely URL-derived and may be empty.
- The index pane is resolved only by the main-area renderer (`MillerColumns`),
  scoped per-app via `appPath`. There is **no** global default.
- `PaneOverlayHost` renders nothing for an empty chain → Sonata shows its piano
  roll.
- `welcomePane` becomes the agent-manager's index (`appPath: "/"`).

Apps that previously inherited welcome at their bare root
(`debug`/`forge`/`deploy`/`file-explorer`/`workflows`) will show an **empty
main column** until the user selects something from the sidebar. This is the
intended, honest state — it surfaces that those apps never declared an index
pane. Giving each its own landing is a separate follow-up, out of scope here.

## Changes

### 1. `plugins/primitives/plugins/pane/web/pane.ts` — stop injecting the index into the chain

- **Remove** the empty-chain fallback block in `parseUrl` (lines ~293-321, the
  `if (chain.length === 0) { … scopedIndex / unscopedIndex … }` and its
  comment). `parseUrl` now returns purely the URL-derived chain — a bare app
  root yields `null`, so `currentChain` stays empty and `useMatchForChain()`
  returns `null` there.

- **Add** an exported hook `useIndexMatch(basePath: string): PaneMatch | null`
  that the main-area renderer calls when the chain is empty. It scans the
  `registry` for a root-segment pane (`segment` is `""`/`"/"`) whose
  `appPath` (normalized via `normalizeAppPath`) equals `basePath`, and returns
  a stable single-entry `PaneMatch`. Key requirements:
  - **Stable identity across renders** so the index pane does not remount:
    `useMemo` keyed on `[basePath, contributions]` where `contributions =
    PaneSlots.Register.useContributions()` (re-runs only when basePath or the
    registry changes).
  - **Stable `instanceId`** per index pane id (cache in a module-level
    `Map<string, number>` allocating `nextInstanceId++` once) and a stable
    `uuid` (`` `index:${pane.id}` ``). Build the `MatchEntry` with empty
    `params`/`fullParams`/`input`.
  - Returns `null` when no app-scoped index pane matches (apps with no index).

- **Update** the `appPath` doc comment on `PaneInternal` (lines ~121-128): it is
  no longer "the app-root fallback in `parseUrl`"; it now marks the pane as the
  index resolved by `useIndexMatch`/`MillerColumns`. There is no longer any
  unscoped/global fallback.

- Reuse the existing `normalizeAppPath` (`pane.ts:530`) and `createSlot`
  helpers. `useMatchForChain` (`pane.ts:962`) is unchanged.

### 2. `plugins/layouts/plugins/miller/web/components/miller-columns.tsx` — render the index when the chain is empty

- Call `const indexMatch = useIndexMatch(basePath);` (unconditionally, after
  `useMatchForChain()`, to respect hook rules) and use
  `const effective = match ?? indexMatch;` for everything below
  (`match.chain.length`, the `if (!match) return null` guard, the column map,
  the scroll effect). When the chain is empty and no app index pane exists,
  `effective` is `null` → renders nothing (the intended empty main column).

### 3. `plugins/layouts/plugins/miller/web/components/pane-overlay-host.tsx` — no code change

It already does `if (!hasPane) return null` and reads `useMatchForChain()`.
Because the chain is now empty at a bare root, `hasPane` is `false` and the
overlay renders nothing → Sonata's piano roll shows. When a global action opens
a real pane (e.g. theme customizer) the chain is non-empty and the overlay
still works. (Verify no behavioral change is needed; leave as-is.)

### 4. `plugins/welcome/web/panes.tsx` — scope welcome to the agent-manager

Add `appPath: "/"` to `welcomePane` (alongside the existing `segment: "/"`).
`normalizeAppPath("/")` → `""`, which matches the agent-manager's basePath
(`apps-layout.tsx:16`, `path: "/"` → basePath `""`). Welcome becomes the
agent-manager's index pane and stops being the global fallback. Mirrors the
`pages` precedent (`page-tree/web/panes.tsx:16-21`).

## Critical files

- `plugins/primitives/plugins/pane/web/pane.ts` — remove index fallback from
  `parseUrl`; add `useIndexMatch`; update `appPath` doc.
- `plugins/primitives/plugins/pane/web/index.ts` — export `useIndexMatch` from
  the barrel.
- `plugins/layouts/plugins/miller/web/components/miller-columns.tsx` — use
  `match ?? useIndexMatch(basePath)`.
- `plugins/welcome/web/panes.tsx` — add `appPath: "/"`.
- (reference, no change) `pane-overlay-host.tsx`, `apps-layout.tsx`,
  `use-active-app.ts`, `page-tree/web/panes.tsx`.

## Verification

1. `./equin build` from the worktree.
2. Sonata fixed:
   `bun e2e/screenshot.mjs --url http://att-1780563880-ypfg.localhost:9000/sonata --out /tmp/sonata`
   → piano roll visible, **no** welcome overlay.
3. Agent-manager unchanged: screenshot
   `http://att-1780563880-ypfg.localhost:9000/` → welcome surface still shows.
4. Pages unchanged: `http://…/pages` → its own `pagesRoot` index still shows.
5. Empty-root apps (expected new behavior): `http://…/debug` (and `/forge`,
   `/deploy`) → sidebar present, **empty** main column (no welcome). Confirm no
   crash / no "Unknown pane".
6. Global pane action still overlays in Sonata: open the theme customizer from
   the floating bar while on `/sonata` → overlay appears; close → piano roll
   returns. (Confirms `PaneOverlayHost` still works for real opened panes.)
7. Deep-link + back/forward sanity: open a task pane in agent-manager, navigate
   to a leaf, use browser back to the bare root → welcome index re-renders
   (index pane resolves with a stable identity, no remount loop).
8. `./equin check` passes (eslint, boundaries, doc-in-sync).

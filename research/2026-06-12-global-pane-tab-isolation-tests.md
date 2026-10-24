# Pane tab-isolation: verification tests + a co-located jsdom test home

Date: 2026-06-12
Category: global (pane primitive + apps tabs + conversations/pane-restore + test infra)

## Context

After the per-tab pane-store refactor, each app tab owns its own `PaneStore`
(`createPaneStore`), exactly one is `live` (the focused tab), and the imperative
free functions + the single module-level `popstate`/`shell:navigate` window
listener forward to whichever store is `live` (`setLiveStore`).

Two isolation concerns were raised and need to be **proven** (and fixed only if a
test goes red — scope decision: *tests-only, fix if red*):

1. `pane-restore-store.ts` registers a module-load `popstate`/`shell:navigate`
   listener that reads the global live-store route (`getRoute()`), so conversation
   restore "may cross-contaminate between tabs."
2. Per-tab route isolation — each store's `prevResolvedByUuid` memo cache,
   `instanceId` uniqueness across concurrently-mounted tabs, and background tabs
   keeping their own route/panes when a global navigation fires — has **no
   automated test**.

### What the code review already establishes (the expected green)

Reading the source, the design appears correct; the tests are expected to pass and
serve as the regression guard. The relevant invariants:

- **No mislabel in pane-restore** (`plugins/conversations/plugins/pane-restore/web/internal/pane-restore-store.ts:37-53`).
  `handleNavigation` reads `getRoute()` (= `liveStore.getRoute()`, the focused tab)
  **and** the key `route[0].params.convId` from that *same* snapshot. Key and data
  come from one read, so it cannot write tab A's route under tab B's conversation
  key. Background stores never dispatch (`setRoute` returns at `if (!store.live)
  return`, `pane.ts:426`), so only the focused tab ever triggers a save.
- **`prevResolvedByUuid` is per-tab** — declared inside the `createPaneStore`
  closure (`pane.ts:409`); each store has its own map.
- **`instanceId` is globally unique** — single module-global counter
  `nextInstanceId` (`pane.ts:45`), incremented in `createSlot` (`pane.ts:61`); all
  tabs share one page/module, so values are monotone and never collide.
- **Background tabs keep their route** — `handleLocationChange` is gated by `if
  (!store.live) return` (`pane.ts:521`), so a focused-tab-driven global `popstate`
  cannot overwrite a background store's in-memory route.

If any test contradicts these, fix the production code at the cited line; otherwise
the tests stand as the verification artifact.

## Approach

### Part A — establish the clean jsdom test home (the "end state" pattern)

Goal end state for future agents:

- **Pure logic → `bun:test`**, co-located as `*.test.ts(x)` next to source. (unchanged)
- **jsdom / React → `vitest`**, co-located under each plugin's `web/__tests__/`,
  auto-discovered by **one shared root vitest project**. No per-plugin vitest config,
  no "all DOM tests live in web-core" rule.

Concretely:

1. Add a root **`vitest.config.ts`** modeled on web-core's
   (`plugins/framework/plugins/web-core/vite.config.ts` + `vitest.config.ts`):
   - `plugins: [react(), tailwindcss()]`
   - `resolve.alias["@plugins"] = <repo root>` (note: root config, so the alias
     target is the repo root directly, not `../../../`)
   - `test.environment = "jsdom"`
   - `test.include = ["plugins/**/web/__tests__/**/*.test.{ts,tsx}"]` — the
     `__tests__/` folder is the discriminator that keeps `bun:test` files (named
     `*.test.ts(x)` *next to source*, never under `__tests__/`) and vitest files
     from cross-loading.
   - `test.setupFiles = ["<root>/test/vitest.setup.ts"]` — promote web-core's
     `setup.ts` (matchMedia + canvas stubs) to a shared root setup.
   - Do **not** set `root:` (web-core only set it for its dev server build; the
     test project wants the repo root so globs resolve plainly).
2. Add a root script: `package.json` → `"test:dom": "vitest run"`.
3. Fold web-core's two existing suites into the root project: they already live
   under `web/__tests__/`, so the root `include` matches them. Remove
   `plugins/framework/plugins/web-core/vitest.config.ts` and its `"test"` script
   to avoid double-running; move `setup.ts` content to the shared root setup (or
   re-export). Re-point web-core's `CLAUDE.md` test instructions at `bun run
   test:dom`.
4. Update root `CLAUDE.md` **Testing** section: document the new rule (pure →
   bun:test next to source; jsdom/React → vitest `*.test.tsx` under the plugin's
   `web/__tests__/`, run via `bun run test:dom`), replacing the "vitest reserved
   for web-core" wording.

> Scope note: this is *test infrastructure*, not a production behavior change, so
> it stays within "tests-only." If preferred, Part A can be reduced to "place the
> new suite under web-core/__tests__" — but that re-entrenches the junk-drawer
> pattern, so the root-project consolidation is recommended as the end state.

### Part B — the isolation test suite

New file: **`plugins/primitives/plugins/pane/web/__tests__/pane-isolation.test.tsx`**.

Registry bootstrap (needed because `resolveRoute` consults the module-global
`registry`, which is filled only by `useSyncPaneRegistry`): mirror
`plugins/framework/plugins/web-core/web/__tests__/plugin-render.test.tsx` — `await
loadPlugins(webEntries)` in `beforeAll`, then render one host
(`<PaneSurfaceProvider store={…}><MillerColumns/></PaneSurfaceProvider>`, or the
real layout host) once so `useSyncPaneRegistry` populates the global `registry`
with all real panes. After that, exercise stores directly.

Use a real registered parameterized pane by importing the actual `PaneObject` and
reading `._internal.id` (e.g. `conversationPane` from
`@plugins/conversations/plugins/conversation-view/web`) rather than hard-coding a
pane id string.

Cases:

1. **instanceId uniqueness across stores** — `createPaneStore()` ×2; `restoreRoute`
   a slot into each; assert the two slots' `instanceId`s differ (and are numeric/
   monotone). `restoreRoute`/`createSlot` need no registry.
2. **`prevResolvedByUuid` stability (per store)** — one store, `restoreRoute` a
   route; `resolveRoute(getRoute())` twice with the *same* slots → assert
   `m2.panes[0] === m1.panes[0]` (identity reused via the memo). Then mutate a
   param (new slot/uuid) → assert a *new* `MatchEntry` identity.
3. **`prevResolvedByUuid` independence (across stores)** — two stores resolving the
   same pane id return distinct `MatchEntry` objects; resolving store B never hands
   back store A's cached entries.
4. **Background store ignores global navigation** — store A `live`, store B
   background, both `restoreRoute`'d to different routes; set
   `window.history.state = { route: <A'> }` and dispatch a real `popstate`
   (jsdom). Assert A's route updates (live `handleLocationChange` ran) and **B's
   route is byte-identical to before** (background gate held).
5. **pane-restore: no cross-contamination** (import
   `@plugins/conversations/plugins/pane-restore/web` so its module-load listener
   registers). `setLiveStore(A)` with a conversation route for conv `X`; spy on
   `localStorage.setItem`; trigger a live `setRoute` (dispatches real
   `popstate`+`shell:navigate`); advance past the 50ms debounce (fake timers or
   `await` ~60ms). Assert `route.restore.X` written with A's slots and
   `route.restore.Y` (conv of background tab B) untouched. Then `setLiveStore(B)`,
   navigate B, assert `route.restore.Y` written with B's slots and `route.restore.X`
   unchanged. Proves key+data stay coherent across a focus switch.

## Critical files

- `plugins/primitives/plugins/pane/web/pane.ts` — store factory, `createPaneStore`
  (`:405`), `prevResolvedByUuid` (`:409`), `resolveRoute` (`:470`), `nextInstanceId`
  (`:45`), `setRoute` live-gate (`:426`), `handleLocationChange` live-gate (`:521`),
  module window listener (`:662`), `setLiveStore` (`:653`).
- `plugins/conversations/plugins/pane-restore/web/internal/pane-restore-store.ts` —
  the flagged listener (`:37-53`).
- `plugins/apps/web/internal/use-tabs.tsx` — `activate`/`focusTab` focus-switch
  flow (`:219-242`), per-store route persistence subscription (`:203-209`).
- `plugins/apps/web/internal/tabs-store.ts` — `Tab`/`PersistedSlot` shapes.
- `plugins/framework/plugins/web-core/web/__tests__/{plugin-render.test.tsx,setup.ts,…}`
  + `vite.config.ts` / `vitest.config.ts` — the precedent to model the root config on.

## Verification

1. `bun install` (or run any `./equin build` first so `node_modules` is present).
2. `bun run test:dom` → the new `pane-isolation` suite plus web-core's two existing
   suites all pass (green confirms the isolation invariants; a red case pinpoints
   the exact production line to fix).
3. `./equin check` → `type-check`, `eslint`, `plugin-boundaries`, and
   `plugins-doc-in-sync` stay green (the new test imports only public barrels;
   confirm no boundary violation from importing `conversationPane` /
   `loadRouteForConversation` in the pane suite — if the import direction is
   illegal, host the suite under a plugin that may legally import both, e.g. a new
   `web/__tests__/` under `conversations` or `apps`).
4. `./equin build` → app deploys clean at `http://<worktree>.localhost:9000`.
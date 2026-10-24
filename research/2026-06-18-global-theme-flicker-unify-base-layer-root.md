# Theme flicker: unify on one boot-hydrated signal + "base layer owns `:root`"

## Context

On a warm reload of an app that has a per-app theme, the app fully renders (icons,
menus, layout) in the **global** theme, then "after a few seconds" switches to the
app's theme. This has been "fixed" several times and keeps coming back — the sign
that the *mental model*, not the patch, is wrong.

**Root cause (verified in code).** The theme of an app is decided by **two
disagreeing, inconsistently-hydrated signals**:

- **membership** = `configV2ScopesResource` (`config-v2.scopes`, keyed `{ path }`) —
  what `useConfig` keys off (`config_v2/web/internal/use-config.ts:70`). Boot-hydrated
  **only for committed git scopes**.
- **forked** = `configV2ScopeForkedResource` (`config-v2.scope-forked`) — what
  theme-engine still gates on via `useScopeForked`. Hydrated **nowhere** except
  theme-engine's own `themeScopeBootTask` for one localStorage-stored scope, and the
  server's `isScopeForked` (`config_v2/server/internal/registry.ts:256`) is
  **override-only** so it returns `false` for committed git scopes.

`ScopedAppTheme` (`theme-injector.tsx:283`) gates the entire per-app `<style>` block
on `useScopeForked` → for a committed git theme it returns `null` forever (app stays
global); for a runtime fork the block emits but its `useConfig` values resolve to
global until membership arrives over WebSocket (the "few seconds"). `Core.Boot` tasks
*are* awaited before first paint (`web-core/web/App.tsx:20-32`), so this is **not** a
boot race — theme reads a signal that simply **isn't in the boot snapshot**.

config_v2 already migrated its own reads off `useScopeForked` onto membership and made
`useConfig` fall back to the **global** value while pending (never to defaults).
Theme-engine is the **last consumer** still on the deprecated forked gate.

**Intended outcome.** One boot-hydrated source of truth for "what theme does this app
use," consumed identically pre-paint and at runtime, expressed as a single rule:

> **The base layer owns `:root`.** When the focused full-surface placement is
> `themeScope:"app"` (docked/solo), `:root` carries that app's theme. When floating
> ("desktop mode"), `:root` carries the desktop (global) theme — stable and
> focus-independent. Any *other* simultaneously-visible app surface whose theme
> differs gets a scoped `[data-theme-scope="app:<id>"]` block. The common case
> (single docked app) emits **zero** scoped blocks and is frame-0 trivially correct.

**Decisions (confirmed with user):** ship **both phases together**; the "Customize
for app" toggle becomes "this app has its own theme" (membership — committed *or*
runtime), which lets us delete the parallel forked signal entirely. Color mode
(`.dark`) stays a single global class (per-scope dark remains deferred).

---

## Phase 1 — One boot-hydrated signal; delete the forked gate

### 1.1 Server: widen the boot snapshot to all user-layer scopes
**File:** `plugins/config_v2/server/internal/resource.ts` — `getConfigSnapshot` (~line 93).

Today the no-`scopeId` branch enumerates scopes via `discoverScopeIdsIn(repoConfigDir, …)`
(git tree only — excludes runtime forks + plain scoped writes). Reuse the existing
**user-layer** enumerator `discoverScopeIds(hierarchyPath)` (`scope-paths.ts:40`, the
same one `computeDescriptorScopes` (`resource.ts:213`) and `initRegistry`
(`registry.ts:327`) use). For each descriptor, enumerate `discoverScopeIds` and filter
by the authoritative `scopeHasOwnConfig(descriptor, sid)` (`resource.ts:296` — covers
committed origins, runtime fork overrides, AND plain scoped writes — the exact
predicate the live `configV2ScopesResource` uses, so snapshot and live resource can
never disagree). Push `{ scopeId, path, values: resolveRedactedConfig(descriptor, sid) }`.

- Do **not** narrow to `scope:"app"` descriptors — committed git scopes on other
  descriptors are a documented feature already boot-hydrated today.
- Delete the now-dead `scope`-keyed branch (`resource.ts:95-104`), the `scopeId` query
  param, the `scope`/`forked` fields from `ConfigSnapshotResult` (~line 82) and the
  endpoint response schema (`config_v2/core/internal/endpoints.ts:35-41`), and the
  `repoConfigDir`/`discoverScopeIdsIn` import if unused elsewhere in the file.
- `getConfigSnapshot` already awaits `registryReady` (`resource.ts:94`) and
  `initRegistry` rehydrates scoped entries before opening the gate — no new race.

**Payload size:** bounded by the `scopeHasOwnConfig` filter (only descriptors that
actually diverge for a scope are emitted; ~14 themable descriptors × few forked apps).
Acceptable; monitor `/api/config-v2/snapshot` size in verification. Fallback if it ever
regresses: hydrate scoped *membership* (`string[]`) for all scopes but keep scoped
*values* lazy (reintroduces a one-frame flash, so prefer full hydration).

### 1.2 Client boot: hydrate all scopes (mostly comments)
**File:** `plugins/config_v2/web/internal/boot.ts` — `configBootTask`.

The existing loop (lines 21-33) already hydrates `configV2Resource { path, scopeId }`
from `scopes` and builds `configV2ScopesResource` membership grouped by path. Because
1.1 widened `scopes`, this now hydrates runtime forks + committed scopes uniformly
**with no code change** — update the stale comments that say "committed only".

### 1.3 Migrate `ScopedAppTheme` off `useScopeForked` onto membership
**File:** `plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx`.

- Add a small public hook `useScopeMembership(descriptor, scopeId): boolean` to
  `config_v2/web`, built from `configV2ScopesResource` + the storePath resolution
  factored out of `use-config.ts` (the membership analogue replacing `useScopeForked`).
- In `GroupStyle`, when `scopeToken` is set (scoped variant), self-gate on
  `useScopeMembership(group.configDescriptor, scopeId)`: emit the scoped `<style>` only
  when that descriptor has own config for the scope; unscoped (`:root`) always emits.
  This is **per-group** and strictly more correct than the all-or-nothing scope-level
  gate. (A member scope whose value equals global emits a harmless inert block — do
  not value-diff to suppress it; that reintroduces a derived signal.)
- Remove `ScopedAppTheme`'s `if (!forked) return null` (line 288) and the
  `useScopeForked` call (line 283); keep the `ThemeScopeProvider`. Children self-gate.

### 1.4 Migrate the other three `useScopeForked` call sites
- **`theme-injector.tsx:204-210`** (persist active scope for the boot task): delete
  entirely with `active-scope-storage` (1.5). Remove the `persistActiveForkedScope`
  import and the `forked` field threaded into `setPaintContext` (line 235).
- **`theme-customizer.tsx:186`** ("Customize for app" toggle): replace with
  `useScopeMembership(themeEngineConfig, scopeId)`. Per the confirmed decision the
  toggle now means **"this app has its own theme"** (ON for committed *or* runtime);
  keep `forkScope`/`deleteScope` semantics (off → drop runtime override, fall back to
  committed-or-base).
- **`theme-toggle.tsx:10`** (light/dark write routing): replace with
  `useScopeMembership(themeEngineConfig, appId ? \`app:${appId}\` : undefined)`.
  Preserve write-routing; `.dark` apply stays global (per-scope dark deferred).

### 1.5 Delete the forked machinery
Confirmed no consumers remain beyond the four sites above. Delete:
- `plugins/ui/plugins/theme-engine/web/internal/boot.ts` (`themeScopeBootTask`) + its
  `Core.Boot` registration in theme-engine `web/index.ts`.
- `plugins/ui/plugins/theme-engine/web/internal/active-scope-storage.ts`.
- `plugins/config_v2/web/internal/use-scope-forked.ts` + its re-export in `web/index.ts`.
- Server: `configV2ScopeForkedServerResource` + its `Resource.Declare`,
  `setScopeForkedChecker`/`scopeForkedChecker`/`ScopeForkedChecker`,
  `isScopeForked`/`isForked` (`registry.ts:244-262`) + the `setScopeForkedChecker` call,
  and the two `configV2ScopeForkedServerResource.notify` sites in `scope-fork.ts:108,117`
  (membership notify via `notifyDescriptorScopeChange` already covers these).
- Core barrel: `configV2ScopeForkedResource`, `configV2ScopeForkedSchema`,
  `ConfigV2ScopeForked` (`core/internal/resource.ts:113`, `core/index.ts`).

### 1.6 Aggregator `forked` plumbing
`forked` only gates "does this app own the global `""` cache entry" (`theme-cache.ts:70`).
Phase 2.3 rewrites this; in the meantime source it from
`useScopeMembership(themeEngineConfig, activeScopeId)` instead of `useScopeForked`, then
remove it in 2.3.

---

## Phase 2 — Base layer owns `:root`

### 2.1 `:root` resolves to the focused full-surface app's theme
**Files:** `theme-injector.tsx`; `plugins/apps/web/internal/use-chrome-theme-scope.ts`.

- Factor a shared **`useRootThemeScope(): string | undefined`** in `apps/web` from the
  existing `useChromeThemeScope` composition (`useFocusedPlacement()` +
  `placementHasAppThemeScope()` (`placement-registry.ts:91`) + `useActiveApp()`).
  Returns `app:<id>` when the focused placement is `themeScope:"app"` and an app is
  active, else `undefined`. Chrome and `:root` then share one definition.
- In `ThemeInjector`, compute `rootScopeId = useRootThemeScope()` and pass it as the
  `scopeId` to the `:root` `GroupStyle`s (line 241), to `useConfig(themeEngineConfig,
  { scopeId: rootScopeId })` for cached color mode (line 220), and to
  `ThemeScopeProvider` (line 255) so color-adjust slot reads resolve at the root theme.
- **Color mode stays global:** `ColorModeApplier` reads `colorMode` at
  `scopeId: undefined` (single `.dark` class), even though `:root` token *values* use
  `rootScopeId`. (Per-scope dark deferred; keeps focus switches from flipping scheme.)

Result: single docked app → `:root` is that app's theme → zero scoped blocks, frame-0
correct, no `data-theme-scope` dependency. Floating → `:root` = global (stable desktop).

### 2.2 Scoped blocks only for other visible, differing surfaces
**File:** `theme-injector.tsx` — `AppScopeThemes` (line 313). **Approach A (recommended,
lowest risk):** keep mounting one `ScopedAppTheme` per registered app at `Core.Root`
(preserves the provider-free mount and the `AppTabsBody`-fallback property), but pass
`rootScopeId` down and have `ScopedAppTheme` return null when
`appThemeScope(appId) === rootScopeId` (the focused app's theme is already `:root`).
Combined with per-group membership self-gating (1.3), unforked apps emit nothing. (Defer
approach B — driving from a new provider-free `useOpenAppIds()` — unless A proves wasteful.)

### 2.3 Pre-paint replay learns the frame-0 root theme
**Files:** `theme-cache.ts`, `paint-cache-aggregator.ts`, `web-core/web/index.html`.

- Because `ThemeInjector`'s `:root` `GroupStyle`s now render `rootScopeId`, the global
  `theme-engine-*` ids the aggregator already caches **carry the focused app's theme**.
  The per-app-path envelope keying then writes the right `:root` block automatically —
  **the replay script needs no structural change** and paints the focused app at frame
  0 with no scope-attribute dependency. This is the payoff of the model.
- Replace the `forked` field on `PaintContext`/`writeCriticalCss` with `rootIsGlobal`
  (`rootScopeId === undefined`): write the `""` global entry only on a desktop/floating
  focus, not "when unforked". Source it from `ThemeInjector` via `setPaintContext`.
- Bump envelope `v: 2 → v: 3` (`theme-cache.ts:36`, the `env.v === 2` checks in `read()`
  and `index.html:33`) — the `""`-ownership semantics changed.
- Scoped `theme-scope-*` blocks for other visible apps remain inert at frame 0 (no
  matching DOM element yet) and harmless, as today. `prune`/`claim` logic unchanged.

### 2.4 Leave per-tab `data-theme-scope` in place
**Do not** remove `data-theme-scope` from tab containers (`surface-body.tsx:272`) or the
`PortalThemeScopeProvider` (line 289): still needed for any non-root visible surface (a
second docked-but-unfocused tab, a floating window, a portaled solo). For the focused
docked tab the attribute now matches `:root` (redundant but correct). The
`inherited-theme-defaults-scoped` check stays **required and unchanged** — a second
visible app's `[data-theme-scope]` subtree must still re-read its own `--font-sans`
(else it inherits the focused app's font); keep the dual `:root, [data-theme-scope]` form.

---

## Risks / edge cases
- **Coexisting placements:** `:root` follows *focused* placement, so focusing a floating
  window flips `:root` token values to global. Intended; `.dark` stays global so scheme
  never flips. Verify `focusedPlacement` (`use-tabs.tsx:106`) updates on window focus,
  not just tab-strip focus.
- **Portals:** a portal from the focused docked app points at `app:<id>` which now has no
  emitted block → inherits `:root` (the same app theme) → correct. A portal from a
  *non-focused* visible app needs its block — covered by 2.2 keeping non-root blocks.
  Test a dropdown/popover from a floating window while a docked app is focused.
- **`prune`:** un-customizing an app unmounts its scoped `GroupStyle` → releases claim →
  prune removes the stale `theme-scope-*` element. Verify no flash and `:root`/other
  scopes survive.
- **`assertComplete`** (`theme-injector.tsx:47`): now also validates scoped merges — more
  coverage, desired (an incomplete scoped preset throws loudly).
- **Boot:** widened snapshot rides the existing `configBootTask` request (no extra
  round-trip, still awaited); deleting `themeScopeBootTask` removes one boot request.

## Critical files
- `plugins/config_v2/server/internal/resource.ts` — widen snapshot; delete forked resource/checker
- `plugins/config_v2/core/internal/{resource.ts,endpoints.ts}`, `core/index.ts` — drop forked resource + snapshot fields
- `plugins/config_v2/web/internal/boot.ts` — comments (hydration already correct)
- `plugins/config_v2/web/internal/use-config.ts` + new `use-scope-membership.ts` + `web/index.ts` — factor storePath resolution, add `useScopeMembership`, drop `useScopeForked`
- `plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx` — per-group membership gate; `:root` = focused app; `AppScopeThemes` skip root app
- `plugins/ui/plugins/theme-engine/web/internal/{theme-cache.ts,paint-cache-aggregator.ts}` — envelope v3, `rootIsGlobal`
- `plugins/ui/plugins/theme-engine/web/internal/{boot.ts,active-scope-storage.ts}` — delete
- `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/components/theme-customizer.tsx`, `plugins/ui/plugins/theme-toggle/web/components/theme-toggle.tsx` — membership
- `plugins/apps/web/internal/use-chrome-theme-scope.ts` — factor `useRootThemeScope`
- `plugins/config_v2/server/internal/{registry.ts,scope-fork.ts}`, `server/index.ts` — delete forked checker + notifies

## Verification (end-to-end)
Set up **both** fork kinds, then scripted-reload each and screenshot frame 0.
1. **Committed git @app scope** (the case broken *forever*): create
   `config/ui/tokens/color-palette/@app/<appId>/config.jsonc` (and/or theme-engine)
   with a visibly different `preset`, line 1 `// @hash <base-origin-hash>`, then
   `./equin build`; confirm `./equin check config-origins-in-sync` passes.
2. **Runtime fork:** open the app → Theme Customizer → toggle "Customize for app" ON →
   change a token.
3. **Reload test:** `bun e2e/screenshot.mjs --url http://<wt>.localhost:9000/<app>`,
   trigger a warm reload, capture frame 0 (immediately after `reload()`/`domcontentloaded`,
   before WS settle) and the settled frame — they must be **identical** (no global→app
   transition). Run for the docked app (`:root` = app, zero scoped blocks) and a floating
   window of a differently-themed app (`:root` = global + scoped block).
4. Inspect `/api/config-v2/snapshot`: the forked app's scope must appear in `scopes`;
   confirm `config-v2.scope-forked` is gone from WS traffic.
5. **Regression:** `./equin check inherited-theme-defaults-scoped type-check` (+
   `migrations`/all checks), `bun run test:dom`, then `./equin build`.

# Sanctioned cross-app navigation + enforcement

## Context

With the tab model, each browser tab is `{ tabId, appId, store: PaneStore }`
(`plugins/apps/web/internal/tabs-store.ts`). Exactly one store is `live` (the
focused tab's); its `setRoute()` mirrors the route into the browser URL with the
app's base path applied. `useActiveApp()` derives the *active app* purely from
`window.location.pathname` by longest-path-prefix match against registered
`Apps.App` contributions (`plugins/apps/web/internal/use-active-app.ts`).

The bug class: any code that navigates to a **different app's path** via raw
`window.history.pushState(url)` (+ a `popstate`/`shell:navigate` dispatch)
changes the focused tab's URL while leaving its `appId` stale. The URL now
resolves (via `useActiveApp`) to a different app than the focused tab actually
is — the tab bar shows the wrong app and the focused store's base path no longer
matches the URL. This has already been hit and patched twice (the app **rail**
and the **Home launcher**, both now call `useTabs().openOrFocus(appId)`), but
nothing prevents the next occurrence. Two live offenders remain (notification
bell deep-links, crash "task →" links), plus two same-app raw-pushState sites.

Goal: provide a **single sanctioned cross-app navigation path** and **enforce it
with a lint rule**, so the whole class is structurally prevented rather than
patched per-site.

## Approach

A cross-app navigation must do three things atomically: (1) resolve the target
app from the URL, (2) open-or-focus that app's tab, (3) set that tab's route from
the URL. `openOrFocus(appId)` only does (2) and can't carry a deep-link route, so
raw `pushState` was the escape hatch. We add a primitive that does all three by
routing through the **live `PaneStore.setRoute`** (never raw `pushState`), then
ban raw history navigation everywhere except the two sanctioned low-level URL
writers.

### 1. Free `navigate(url)` primitive (NOT a hook)

**Critical constraint:** `BellButton` and `ThemeCustomizerButton` are
`ActionBar.Item` contributions rendered in **two** places — the agent-manager
toolbar (inside `TabsProvider`) **and** the `FloatingBar`, which is a sibling
`Core.Root` (`plugins/shell/plugins/floating-bar/web/index.ts:10`) mounted
**outside** `TabsProvider`. A bare `useTabs()` there throws
`"useTabs() called outside <TabsProvider>"`. So the primitive must be callable
without the provider.

Mirror the existing `setLiveStore`/`liveStore` module-pointer pattern in
`pane.ts:643-654`: `TabsProvider` registers its `navigate` impl into a
module-level ref on mount (`setTabsNavigator(fn)`), and `@plugins/apps/web`
exports a **free `navigate(url: string): void`** that delegates to it. Also
expose `navigate` on `TabsApi`/`useTabs()` as a convenience for in-provider
callers — both delegate to the same impl.

`navigate(url)` logic:
- `const resolved = resolveAppForPath(url, apps)` (see §2). `const route = parseUrl(resolved.routePath) ?? []` (empty route = app index; `parseUrl` returns `null` for an empty route, `pane.ts:316`).
- If a tab for `resolved.app.id` is **already focused**: its store is live → call `store.setRoute(route)` directly (normal `pushState`, correct back-target for same-app nav).
- Else if a tab exists: seed the route into that (still background) store, then focus it.
- Else: open a new tab for the app, seeding the route before activation.

**Avoid the stray-history-entry hazard:** today `activate()`
(`use-tabs.tsx:178-187`) hardcodes `store.setRoute(store.getRoute(), /* replace */ true)`,
which mirrors the tab's *current* (old/empty) route. If we focus/open first then
`setRoute`, `activate` first does a `replaceState` to the bare app root (e.g.
`/agents`) — clobbering the outgoing app's history entry — and *then* our push
adds the target, producing a double event-dispatch. Instead **seed the target
route into the background store before flipping liveness**: a background store's
`setRoute` is a pure in-memory update (no history op — `pane.ts:426` early-returns
for non-live), so when `activate` then runs its single
`setRoute(getRoute(), replace=true)`, it mirrors the *already-correct* route in
one `replaceState`. Add internal `openTabWithRoute(appId, route)` /
`focusTabWithRoute(tabId, route)` helpers (or thread an optional target route
into `activate`) that set base path + route on the background store first.

Keep `activate`'s `replace=true` for the focus/open path (consistent with
today's tab-switch history semantics).

### 2. Shared pure resolver

New `plugins/apps/web/internal/resolve-app.ts`:
`resolveAppForPath(pathname, apps): { app: ActiveApp; routePath: string } | undefined`.
- Lift the longest-`path`-prefix sort + `appMatchesPath` out of
  `useActiveApp` (`use-active-app.ts:33-35`). On match: `{ app, routePath: stripBasePath(pathname, app.path) }`.
- On no match, if a `fallback: true` app exists: `{ app: fallback, routePath: pathname }` — the **raw** pathname (so `setBasePath(fallback.path)` + this route mirrors to `fallbackPath + pathname`, matching `apps-layout.tsx:186`). Else `undefined`.
- Import `stripBasePath`, `parseUrl` from `@plugins/primitives/plugins/pane/web`.

Reuse it from both `useActiveApp()` (replace inline match with
`resolveAppForPath(pathname, allApps)?.app`) and `navigate()`, and from the
`apps-layout.tsx` canonicalization effect (DRY the matching; the raw
`replaceState` write there stays — see §4).

### 3. Enforcement: `no-raw-history-nav` lint rule

New `plugins/apps/lint/no-raw-history-nav.ts` + `plugins/apps/lint/index.ts`
(default-export `{ name: "apps", rules, ignores }`), mirroring
`plugins/infra/plugins/endpoints/lint/no-raw-web-fetch.ts` (visitor style with
the `calleeName` helper, `no-raw-web-fetch.ts:27-34`) and its `index.ts` for the
`ignores` glob shape.

- Match `CallExpression` whose callee is a `MemberExpression` with
  `property.name` of `pushState` **or** `replaceState`. A single check per
  method covers **both** `window.history.X(...)` and bare `history.X(...)` (the
  leaf `.property.name` is identical; the object chain differs but is
  unconstrained). No separate bare-`history` selector needed.
  - Does **not** match `window.history.back()/.forward()` (`pane.ts:982,986`) or
    `window.history.state` reads (`pane.ts:522`) — no false positives.
- Message → use `navigate(url)` from `@plugins/apps/web`.
- `ignores` allowlists the two sanctioned low-level URL writers (repo-relative
  globs, per `endpoints/lint/index.ts:11-31`):
  - `plugins/primitives/plugins/pane/web/pane.ts` — the live store's `setRoute` (`pane.ts:431-432`), the one legitimate route→URL mirror.
  - `plugins/apps/web/components/apps-layout.tsx` — the pre-tab `redirectTo` canonicalization (runs before `TabsProvider`/any live store exists).

**Do not** ban the `popstate`/`shell:navigate` dispatch: it's the legitimate
notification mechanism emitted by the sanctioned `setRoute` itself
(`pane.ts:433-434`) and consumed by `usePathname`/`useActiveApp`. The desync is
always anchored by a `pushState`/`replaceState`; banning that anchor is
necessary and sufficient.

The root `eslint.config.ts` auto-discovers `lint/index.ts` via
`buildLintConfig`/`loadContributions`; `./equin build` regenerates
`plugins/framework/plugins/tooling/plugins/lint/core/lint.generated.ts` to
include the new `apps` entry.

### 4. Migrate the 4 offender call sites → free `navigate(url)`

| File | Current | Change |
|---|---|---|
| `plugins/shell/plugins/notifications/web/components/bell-button.tsx:46-50` | local `navigateTo` raw pushState, prop-drilled | drop the prop; call free `navigate(n.linkTo!)` directly in `NotificationRow` (BellButton can't use the hook — floating bar) |
| `plugins/debug/plugins/crashes/web/components/crashes-view.tsx:11-15` | local `navigateTo` raw pushState | call free `navigate(`/tasks/t/${c.taskId}`)` in `CrashRow` |
| `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/components/theme-customizer-button.tsx:23-27` | raw pushState to `activeApp.path` | `navigate(path)`; keep the `location.pathname !== path` guard |
| `plugins/apps/plugins/agent-manager/plugins/shell/web/components/agent-manager-layout.tsx:16-19` | `history.pushState('/agents')` | `navigate("/agents")` |

`apps-layout.tsx`'s `redirectTo` effect (`:180-188`) is **rewritten to use
`resolveAppForPath`** for the canonicalization decision but keeps its own
`replaceState` (allowlisted) — it's pre-tab URL normalization with no live store
to route through. Keep the `/` → `/home` special-case.

## Critical files

- `plugins/apps/web/internal/use-tabs.tsx` — add `navigate`, `setTabsNavigator`, `openTabWithRoute`/`focusTabWithRoute`.
- `plugins/apps/web/internal/resolve-app.ts` — **new** shared resolver.
- `plugins/apps/web/internal/use-active-app.ts` — use the resolver.
- `plugins/apps/web/index.ts` — export free `navigate`.
- `plugins/apps/web/components/apps-layout.tsx` — canonicalization via resolver.
- `plugins/apps/lint/index.ts` + `plugins/apps/lint/no-raw-history-nav.ts` — **new** rule.
- `plugins/primitives/plugins/pane/web/pane.ts` — reference for `setLiveStore`/`liveStore` pattern, `setRoute`, `parseUrl`, `stripBasePath` (no change).
- The 4 offender files above.

## Verification

1. `./equin build` — regenerates `lint.generated.ts` (confirm the `apps`
   entry appears) and deploys. App at `http://<worktree>.localhost:9000`.
2. `./equin check` — confirm `apps/no-raw-history-nav` fires on a probe
   `window.history.pushState` (and a bare `history.pushState`), the two
   allowlisted files are exempt, and the 4 migrated files pass clean.
3. **Playwright desync regression** (the delta that was the bug):
   - Open a **non-fallback** app tab (rail → Debug, open the Crashes pane).
     Assert the focused tab's app identity = Debug (tab-bar label / `useActiveApp`).
   - With a crash that has a `taskId` (or a notification with `linkTo: /c/:id`),
     click the cross-app link.
   - Assert `window.location.pathname` is now under the target/fallback app
     (e.g. `/agents/tasks/t/:id`), **and** the focused tab's `appId`/base path
     now follows the URL (tab bar shows the target app, not stale Debug).
     Pre-fix, the URL changed but the tab bar stayed Debug — that delta is the
     regression test.
   - Use the `e2e/screenshot.mjs` helper (`--click` the link, assert before/after).

## Out of scope / follow-ups

- Back-target semantics on cross-app focus switch: `activate` uses
  `replace=true`, so a notification click replaces rather than pushes the
  outgoing entry. Changing this touches all tab switches — defer.

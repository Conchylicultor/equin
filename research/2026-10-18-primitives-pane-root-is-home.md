# A surface's root pane is homed in the surface's app

## Context

`useOpenPane()` / `openPane()` (`plugins/primitives/plugins/pane/web/pane.ts:3091`, `:3204`)
always write to the current surface's store, so the URL goes under the current app, whatever the
target's `Pane.define({ app })`. From Places, the Google Maps "Set up…" buttons opened
`/places/accounts/google-maps/live-map`. The whole route was Settings panes, and Places' full-pane
layout drew it full screen with no Settings nav. URL parsing (`pane.ts:~605`) matches every
registered pane under every app, so nothing rejects that route. The three call sites were fixed by
hand with `appLinkProps(pane.link(settingsApp, {}))`. The wrong spelling still type-checks.

Hosting a pane outside its home app is legitimate as a **guest**: page detail beside a conversation
in the agent manager, plugin panes pushed beside a conversation, the theme customizer. So "foreign
pane = error" is the wrong guard.

## The invariant

**A guest is always hosted *beside* a pane of the host app. It is never the root of the host's
route.** A route whose root pane is homed elsewhere is not hosting. It is the other app's surface
stranded in this one.

The pane docs already treat this as a bug. Expand offers "Open in <home app>" even at position 0,
because "`/agents/page/X` is a page stranded in the agent manager, which is precisely the case worth
fixing" (`pane/CLAUDE.md` § *A pane's home app*). `usePromote()` already obeys the rule: it re-roots
in place only when `home.id === surfaceAppId`, and hands off cross-app otherwise (`pane.ts:2480`).

So the guard checks the result of an open, not the call. If the computed route's root is foreign,
the open is a cross-app navigation.

## Design: make the wrong outcome unreachable (rung 1)

The in-app opener routes by home app itself. Callers keep one spelling,
`openPane.link(pane, params, { mode: "root" })`. When the result would strand a foreign root, it
does what Expand does and hands the pane's app-rooted URL to the tab manager. Guest opens (push,
swap, append beside a host pane) are untouched.

### 1. A shared decision helper in `pane.ts`

Add `resolveOpen(store, surfaceAppId, navigator, target, params, computed)`, which returns either
`{ kind: "in-place", next }` or `{ kind: "cross-app", url }`:

- Use `cross-app` when `surfaceAppId !== undefined` **and** the computed route's first slot resolves
  (through `registry`) to a pane whose `app.id !== surfaceAppId`.
- The URL is built with `RouteDef.link(home, params)` (`pane/core/route.ts:445`), the same builder
  `crossAppUrl` (`pane.ts:2283`) uses. Reuse it rather than writing another.
- Check the *outcome*, not `mode`. A `push` with no caller instance (global chrome) can also build a
  route from scratch (`computeOpen`, `pane.ts:1783`), and it is covered too.
- If the result is cross-app and no navigator is installed (no tab provider), throw a named error.
  Rendering in place is exactly the bug, so it must not be the fallback. Outside a surface
  (`surfaceAppId === undefined`, e.g. store-only test suites) there is no app to compare, so the
  open goes in place as today.

### 2. `useOpenPane()` uses it in all three forms

- `open` gets `navigator(url)` instead of `store.setRoute`.
- `to().href` returns `url`, so ⌘/middle-click opens the home app in a new browser tab. This matches
  Expand's `href`.
- `link` follows automatically, since it is `linkProps(to(...))`.
- Read the navigator with `useAppNavigator()` (`pane/web/app-nav-sink.ts:86`), subscribed, for the
  reason given in the `usePromote` comment. An embed's `AppNavBoundary` then keeps working.

### 3. The imperative `openPane()` (root-only, `pane.ts:3091`) does the same

`openPaneImpl` gets the same check. It reads the live store's surface app; this needs the store to
know its app id, not just its base path (see step 4). It uses `navigateApp` (`app-nav-sink.ts:53`),
which already throws when no navigator is installed.

### 4. The store knows its app id, not only its base path

The tabs code calls `store.setBasePath(appPathFor(appId, apps))` (`apps-core/plugins/tabs/web/internal/use-tabs.tsx:219,398,559,596`).
Replace that with `store.setApp(appRef)`, which derives the base path from it. Then the store, the
imperative opener and URL parsing all see the app without a separate React context read.
`useSurfaceAppId()` can keep its context, but must agree with the store. One source is better: make
the context read from the store if that's clean, and decide this during implementation.

### 5. Backstop at URL parsing (rung 4)

Hand-typed URLs, stale tab URLs and old links (`/places/accounts/google-maps/live-map`,
`/agents/page/X`) never go through the opener. When the surface parses a URL to a matched route
whose root pane is foreign, it redirects to `rootPane.route.link(home, params)` through the app
navigator, with `replace`, instead of rendering. The route is still parseable; this only changes
which app the route lands in. Put it where the tab and surface resolve `parseRouteUrl`'s result, not
inside the pure parser.

### 6. Simplify the call sites that work around it

These go back to the plain in-app spelling, because the opener now does the hand-off:

- `integrations/plugins/google-maps/web/components/{maps-map-access-action,map-id-raster-notice,maps-access-action}.tsx`

`appLinkProps(pane.link(app, …))` stays valid for a raw cross-app URL, but nothing should need it
for a pane.

### 7. Docs

`pane/CLAUDE.md` § *A pane's home app*: add the root-is-home invariant, what the opener does, and
that guests are hosted beside a host pane.

## Behavior changes to accept

- Shared plugins' root opens of foreign panes now switch apps instead of rendering in place. An audit
  of `mode: "root"` outside `plugins/apps/` found `sidebar-nav-item`, the auth provider rows,
  `use-conversation-opener`, `expand-agent-button` and `conversation-list`. Each opens a pane of the
  app that renders it in normal use, so nothing changes there. If one is rendered in a foreign app,
  it now lands in the pane's home app, which is the intended fix.
- Persisted tabs sitting on a stranded URL (`/agents/page/X`) get redirected to the home app on next
  load.

## Decided: no exception for the theme customizer

The theme customizer (`themeCustomizerPane`, `app: settingsApp`) is the only pane found that is
opened on purpose as the first pane of another app's route. `quick-theme-button.tsx:32` builds
`activeApp.basePath + themeCustomizerRoute.path({})`, giving `/places/theme`, so it restyles the app
you came from.

- **Decision (user, 2026-10-18):** no `rootAnywhere` opt-in. The customizer is legacy and will be
  removed.
- **What changes:** step 5 redirects `/places/theme` to `/settings/theme`, so quick-theme's "Open
  theme editor" opens the customizer for Settings, not for the app you were in. The quick-theme
  popover itself still themes the active app. The customizer is still reachable from the Settings
  nav (Appearance).

How "the only one" was established:

- Every URL built from an app's base path (`basePath` uses outside the pane primitive) was checked.
  Only quick-theme builds a cross-app route of a pane this way.
- Every sidebar `opens: { pane }` entry was checked. These are opened with `mode: "root"` by
  `sidebar-nav-item`. Each pane is homed in the app whose sidebar lists it (Debug ↔ `debugApp`,
  Settings ↔ `settingsApp`, …).
- Shared chips (conversation, page, plugin) open with `push`, as guests.

If another deliberate foreign root exists, the redirect makes it visible straight away: it lands in
its home app instead of failing silently.

## Not a problem: guests pushed in full-pane apps

`FullPane` draws only the last pane, but with `ancestorsHidden: true` it gives that pane a Back
button. A pushed guest is just another screen on the stack: Back returns to the host, and the pane
wears its home theme through `PaneBox`. No app code pushes a foreign pane in a full-pane app today.
There is nothing to fix.

## Critical files

- `plugins/primitives/plugins/pane/web/pane.ts` — `resolveOpen`, `useOpenPane`, `openPane`/`openPaneImpl`, store `setApp`
- `plugins/primitives/plugins/pane/web/app-nav-sink.ts` — reused as is
- `plugins/primitives/plugins/pane/core/route.ts` — `RouteDef.link`, reused
- `plugins/apps-core/plugins/tabs/web/internal/use-tabs.tsx` — `setBasePath` becomes `setApp`; parse-time redirect
- `plugins/integrations/plugins/google-maps/web/components/*` — revert to `openPane.link`
- `plugins/primitives/plugins/pane/CLAUDE.md`

## Verification

- Unit tests in `pane/web/__tests__/` (the surface fixture with two `defineApp` fixtures and a stub
  navigator):
  - A root open of a foreign pane calls the navigator with the home URL and leaves the store's route
    unchanged.
  - `.to().href` returns the home URL.
  - A push beside a host pane stays in place, with the guest kept.
  - A no-caller push that would root a foreign pane hands off.
  - With no navigator, the open throws.
  - Outside a surface, the open stays in place.
- A test for the parse-time redirect at the tabs layer.
- `./singularity test plugins/primitives/plugins/pane plugins/apps-core`
- `./singularity build`, then with the `browser_*` tools:
  - Places → "Set up the live map" lands on `/settings/accounts/google-maps/live-map` with the
    Settings nav.
  - Opening `/places/accounts/google-maps/live-map` directly redirects to the same place.
  - Page detail still opens beside a conversation in the agent manager.
  - Expand still says "Open in Pages".
- Run `plugins/primitives/plugins/pane/e2e/expand-verify.ts`.

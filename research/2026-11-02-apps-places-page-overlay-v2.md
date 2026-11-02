# Places — page overlay, v2: the overlay is a view (`;page=`) of the one map pane

Supersedes the routing part of [`2026-10-31-apps-places-page-overlay.md`](./2026-10-31-apps-places-page-overlay.md).
Everything else in v1 stays as built.

## Context

v1 made the page overlay its own pane: `placesPageOverlayPane`, route
`from-page/:pageId`. The user reported that closing it looks like a full app
reload.

**Root cause.** It is not a page reload, and not the cross-app navigator. For a
same-app link, `inAppLink(...).open()` → `navigate()` takes the same-app branch
(`focused.store.setRoute`, `apps-core/tabs/web/internal/use-tabs.tsx` ~932).

The two panes render different component types (`PlacesScreen` vs
`PlacesPageOverlayBody`, in `places-map/web/panes.tsx`), and `FullPane` renders
the active pane in place. Switching panes therefore unmounts the whole screen:
the Google map, the DataView, all state. Each screen's `ResourceView` then shows
its loading block until its reads land.

**Structural issue.** The overlay is a *view* of the same map, not another
screen. The route grammar has the right concept for that: a keyed param
(`;name`). A keyed param is "a VIEW of the entity; changing it must not remount
the pane" (`pane-resolve-guard.tsx`, Sonata's `;lens`). But the grammar forbids
keyed params on an index pane (`assertKeyedParams`, `pane/core/route.ts` ~438:
"need a URL part of the segment's own").

So every "app home plus an optional view" was pushed into a second pane. v1's
`page-overlay/core/internal/route.ts` comment says exactly that.

**Fix.** Let an index pane declare keyed params, written on the app's base path
(`/places;page=<id>`). Make the overlay `placesMapRoute`'s `;page`. Delete the
second pane. Opening, closing and back/forward then only change a param of a
mounted pane.

## Design

### 1. Pane primitive: keyed params on an index route
The URL half already exists. Surface view keys already ride on an index pane's
base path (`/sonata;view.sonata.library=all`):

- `parseUrl` puts a leading `;…` part into `index`;
- the store's `applyBasePath` / `stripBasePath` join and strip `/;`;
- `appMatchesPath` accepts `appPath;`;
- history and tab state carry `index`.

What is missing is the *declared names* half. Changes in
`plugins/primitives/plugins/pane/core/route.ts` and `web/pane.ts`:

- **`assertKeyedParams`**: allow keyed names on a segment with no positional
  part (`";page"`). The identifier, reserved `view` and duplicate checks stay.
- **`fillSegment` / `path` / `link`**:
  - A keyed-only segment writes its pairs as a suffix of the previous part, or
    of the base path when it is first. `path` emits `"/;page=x"`.
  - `link` joins it the way `applyBasePath` does, giving `/places;page=x`, not
    `/places/;page=x`.
  - An absent value writes nothing, so the link stays `/places/`.
  - Today the keys are silently dropped (`parts.length > 0`). That silent drop
    goes away.
- **Index suffix read/write:**
  - `indexKeyedSuffix(params)` writes the index segment's declared names first,
    in declaration order, then the surface view keys.
  - `readIndexKeyedParams` keeps identifier keys. `parseUrl` is basePath-agnostic,
    so it keeps every well-formed identifier key, and `useIndexMatch` filters them
    against the index pane's declared names. An undeclared key is ignored, as
    today.
- **`useIndexMatch`** (~3368): `params` / `fullParams` become the declared keyed
  values from `index` (not `{}`). `placesMapPane.useParams()` then returns
  `{ page?: string }`.
- **`store.setParams`** (~1292): an index branch like `setKeyedParam`'s
  (~1330). It rewrites `currentIndex` (declared keys and views kept) and commits
  a history push, with no slot and no remount. `useSetParams` on the index pane
  then works.
- **Opening an index pane with params:**
  - `openPane(indexPane, params, { mode: "root" })` routes to
    `clearRoute({ index: params })`.
  - Today `computeOpen` / `chainSlots` mint a slot whose URL drops the keys.
  - An index pane can only be opened at the root.
- **Registry and checks** treat "owns a URL part" as *positional* emptiness
  (`parseSegmentParts(segment).length === 0`), not `segment !== ""`. This applies
  to:
  - `useSyncPaneRegistry`'s appIndex assert (~3229) and its collision skip
    (~3249);
  - `pane/check/index.ts` `pane:segments-unique` (~105);
  - `segmentMatchPatterns`, so two keyed index panes don't "collide" on `""`.
- **Types**: `AppIndexField<Seg>` (~3029) also accepts `` `;${string}` ``.
  `RouteParams<";page">` already gives `{ page?: string }`.
- **Index routes with children** (Deploy, Prototypes, Home today): an index
  route that declares keyed params *and* has child routes throws at
  registration. Today an open drops the index params and a minted ancestor slot
  writes no URL part, so it is not well-defined. The throw is loud and its
  message says why. Places has no child routes. Lifting the restriction is a
  later change, for when an app needs it.
- **Tab persistence**: `apps-core/tabs/web/internal/tabs-store.ts`
  `rawPathForTab` returns `""` for a tab with no slots, so a reload loses the
  index suffix (views today, `;page` now). Persist `index` with the tab state
  (the shell history adapter already serializes it) and rebuild the raw path
  from it.
- **Fix the stale doc comment** on `buildRouteUrl` (it cites
  `applyIndexToBase`; the function is `applyBasePath`). Update the pane
  CLAUDE.md section on keyed params: index panes may declare them, written on
  the base path.

### 2. Places: one pane, `;page` as its view
- **`placesMapRoute`** becomes `defineRoute({ id: "places-map", segment: ";page" })`.
  Then:
  - delete `placesPageOverlayPane`, `PlacesPageOverlayBody` and
    `page-overlay/core`'s `placesPageRoute`, with its comment;
  - regenerate the pane identity snapshot (`check/write-identity-snapshot.ts`).
- **`placesMapRoute` moves** to `page-overlay/core`, or stays in places-map and
  page-overlay imports it. Whichever keeps the dependency direction: places-map
  → page-overlay, and the Pages-side action only needs the route and
  `placesApp`. The `OpenInPlacesAction` links to
  `placesMapRoute.link(placesApp, { page: pageId })` → `/places;page=<id>`.
- **One `PlacesScreen`** reads `placesMapPane.useParams().page`.
  - `PlacesPageScreen` is folded in. The overlay reads (`usePageOverlay`) are
    mounted only while `page` is set, as a child component, so the map's own
    `ResourceView` never re-gates on them.
  - The screen's loading gate covers only places and tags, so the overlay's
    loading is the panel's own state.
- **Close (×)** calls `placesMapPane.useSetParams()({ page: undefined })`, or
  `clearRoute({ index: {} })`. It is the same pane, so it is a history push and
  no remount: back reopens the layer and forward closes it.
- **Camera:**
  - The remembered camera (`cameraKey`) is read once at mount
    (`useRememberedCamera`), so it can't depend on `page`.
  - On a cold load with `;page`, keep `cameraOpen: "framed"` + `focusIds`.
  - When `page` becomes set on a mounted map (back/forward, or an in-app open),
    and once the overlay's items are ready, bump `fitRequest` with `focusIds`.
    This happens once per page id.
  - Closing leaves the camera where it is and drops `focusIds`.
- **The page link** from Pages is cross-app, so it still goes through
  `inAppLink` and gets the Places tab's usual handling. Inside Places,
  everything uses the pane API (`useSetParams`), never `inAppLink`.

## Files (representative)
- `plugins/primitives/plugins/pane/core/route.ts` (+ `route.test.ts`)
- `plugins/primitives/plugins/pane/web/pane.ts`
- `plugins/primitives/plugins/pane/check/index.ts` and the identity snapshot
- `plugins/primitives/plugins/pane/web/__tests__/` (an index keyed-param test, from `view-param.test.tsx`'s base-path view test)
- `plugins/apps-core/plugins/tabs/web/internal/tabs-store.ts` (index persisted)
- `plugins/apps/plugins/places/plugins/places-map/web/{panes.tsx,components/places-screen.tsx,internal/routes.ts}`
- `plugins/apps/plugins/places/plugins/page-overlay/{core,web}/…` (route removed, the action's link)
- The CLAUDE.md prose of `pane`, `places-map` and `page-overlay`; a v1 plan note pointing here

## Execution
1. **One Opus agent** does §1 (pane primitive and tab persistence) with tests.
   It runs `./equin check` and `./equin test plugins/primitives/plugins/pane plugins/apps-core`.
2. **One Opus agent** does §2 (Places) on top, then builds, then runs the e2e
   below.
3. **Me:** review the diff against the merge-base and report.

## Verification
- **Unit, route.ts:**
  - `";page"` is accepted, while `";view"` / duplicates still throw;
  - `link(app, { page: "x" })` → `/places;page=x`, and `link(app, {})` → `/places/`;
  - `readIndexKeyedParams` keeps declared keys;
  - an index route with keyed params and children throws.
- **Unit, pane store (vitest):**
  - `/lib;page=x` resolves the index pane with `useParams() = { page: "x" }`;
  - `useSetParams({ page: undefined })` keeps the same mounted component
    (a render counter / instance ref), writes `/lib/`, and back restores
    `;page=x`;
  - a tab reload keeps `;page`.
- **`./equin check`** (all checks, segments-unique and the identity snapshot
  among them) and `./equin test` on the touched plugins.
- **e2e script** `places-map/e2e/page-overlay-close.ts` (shared harness, run with
  `./equin run`). It checks:
  - opening `/places;page=<pageId>` shows the panel;
  - after tagging the map's DOM node and setting a window flag, × leaves the URL
    at `/places`, the panel gone, the *same* map node in the DOM and the window
    flag intact;
  - browser back brings the panel back on the same node;
  - the Pages map block's Open in Places lands on `/places;page=<id>`.

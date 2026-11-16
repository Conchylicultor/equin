# One-tree static render

## Context

Build `build-1794814782-2rkiu7` (`./equin build`, target `website`, commit
`393de40762`) failed at the website's crawl snapshot. Rendering `/about`
threw `scoped-store: hook used outside its <Provider>` from
`LiveDemoSection` (`apps/website/landing/screenshot`). Since 263b77ce03
that band reads the live-demo store. The store's Provider is a
`Website.Resident`, folded around `<FullPane />` by `WebsiteLayout`, the
website's `Apps.App` layout.

The static renderer (`primitives/dom/static-render`, `renderPage`) never
mounts that layout. It rebuilds the app's root by hand:
`TransportProvider → NotificationsProvider → PluginProvider →
PaneSurfaceProvider → <FullPane />`. That stack is a copy of what the
browser mounts, and it drifted the moment a layout gained a wrapper. Nothing
caught it before deploy, because the static take only runs in
`./equin build --composition website`.

Outcome:

- A page renders statically through the same surface subtree the browser
  mounts: `SurfaceCore` and the app's own `Apps.App` layout. Whatever wraps
  the pages live wraps them statically, and there is no second list to keep
  in sync.
- What is not part of the document is decided by the primitive that draws
  it, not by where it is mounted.
- A check runs the static take, so a website page that cannot render
  statically fails the push, not the deploy.

## What exists already (reused, not rebuilt)

- **`SurfaceCore`** (`apps-core/tab-surface/web/components/tab-surface.tsx:113`)
  is exported. Its props are `{ appId, store, surfaceId, residency?, reporters?, beside? }`.
  - It works with any `PaneStore`.
  - It renders `PaneSurfaceProvider → RouteScrollRevival → SyncStatusProvider
    → UndoRedoProvider → SurfaceOverlayHost → renderIsolated(Apps.App) +
    SyncStatusIndicator`.
  - Exploration found every one of these blocks static-safe: server snapshots
    are passed, effects-only behaviour, and the indicator is `null` while
    idle.
  - `TabSurface` is its only caller. Its doc comment mentioning "an
    in-process app embed" is stale, because `app-embed` goes through
    `AppTabsBody`.
- **The floating primitives already leave the document.**
  - `SurfaceOverlay` (`overlay/surface-overlay`), `ViewportOverlay`
    (`css/viewport-overlay`), `FloatingSurface` (popovers), the toasts and
    `CursorAnchoredMenu` all `return null` when `renderMode() === "static"`.
  - `Pin` / `Layer` / `Overlay` are in-flow positioning and do render. That
    is correct: they are part of their parent's box.
- **`renderMode()`** (`dom/render-mode/core`) is the one way to ask.
  `dom-access-safety/no-render-time-dom` accepts it as the guard.
- **`crawlSnapshotDirName`** (`web-artifacts/core/internal/crawl-snapshot.ts`)
  is a content address over everything the take reads: the take's module
  graph, every web barrel of the composition, the data it globs, the
  dependencies and the cluster. **`ensureCrawlSnapshot`** returns early on an
  artifact-store hit and publishes on success.

## Design

### 1. The static renderer mounts the app's surface

In `static-renderer.tsx` `renderPage`, replace the hand-built
`PaneSurfaceProvider → StaticPane → <FullPane />` with:

```tsx
<TransportProvider transport={staticTransport}>
  <NotificationsProvider>
    <PluginProvider plugins={plugins} composition={composition}>
      <SurfaceCore
        appId={app.id}
        store={staticStore}          // createPaneStore({ live: false }), seeded with the path
        surfaceId="static"
        reporters={<StaticPaneCheck expected={…} report={report} />}
      />
    </PluginProvider>
  </NotificationsProvider>
</TransportProvider>
```

- **`StaticPaneCheck`** is today's `StaticPane` without the `<FullPane />`.
  - It asserts that the path resolves to a registered pane, and to the
    expected one when given, and reports the pane's title.
  - It renders `null` and rides `SurfaceCore`'s existing `reporters` slot,
    which sits inside `PaneSurfaceProvider`, beside the app.
  - No new `SurfaceCore` prop is needed.
- **The app is resolved by registered `Apps.App`**, not by
  `Pane.Register`'s `AppRef`s.
  - `SurfaceCore` throws for an app with no `Apps.App`, and for a
    surface-mode app. That is the loud failure we want: a page whose app has
    no layout cannot be rendered the way the browser renders it.
  - `appOf`, `home` and `moved` keep reading the same `AppRef`s.
- **The three outer providers stay explicit.** They are the host's inputs
  (transport, live-state pipeline, plugin set), not app structure, and they
  differ by construction from `App.tsx`: a static transport, no socket, a
  standalone `PluginProvider`.
  - The drift-prone part is everything below them, which is now shared code.
  - `App.tsx`'s boot state machine and `Core.Root` (tabs, rail, tab bar) stay
    browser-only. A static page is one surface, not the tab shell.
- **New dependency:** `primitives/dom/static-render` → `apps-core/tab-surface`
  (web).
  - `primitives/pane` already imports `apps-core`, so the folder table allows
    it.
  - `static-render` is an excluded plugin that `apps-core` never reaches, so
    there is no cycle. Confirmed by `./equin check plugin-boundaries`.

`WebsiteLayout`, `Website.Resident` and `live-demo` do not change.
`DemoResident` provides the store. `DemoServer` renders `null`, since the
demo is never started without a click. `DemoTarget` draws its documented
static state (the boot screen's first frame).

### 2. Floating UI leaves the document through its primitive

The rule, written into `static-render/CLAUDE.md`: **the document is the app's
surface as rendered. Anything drawn over the page goes through a floating
primitive (`SurfaceOverlay` / `ViewportOverlay` / `FloatingSurface`), and
those render nothing statically.**

`Website.Layer`'s contract is "floats over every page", so its host
(`WebsiteLayout`'s `<Website.Layer.Render />`) renders the layers inside one
`<SurfaceOverlay>`. With the surface now `SurfaceCore`'s, there is a
`SurfaceOverlayHost` in both renders.

- A layer is floating by construction. A future layer (a banner, a promo) is
  out of the crawl without its author thinking about it.
- The consent prompt keeps its own `Pin`/CSS placement inside the overlay.
  The `.consent-prompt` `position: absolute` corner moves onto a `Pin` to the
  overlay's corner. Its `consent !== "undecided"` check stays, as the
  visitor's state rather than a static-render guard. Today the prompt is
  hidden statically only because the consent store's server snapshot reads
  `"unknown"`, which is a coincidence and not the reason.

Also fix the stale line in `static-render/CLAUDE.md` ("portals rendered in
place"). The overlays render nothing; only in-flow portals such as
`DemoTarget`'s render in place.

### 3. A check runs the static take

`apps/website/crawlable/check`: `crawlable:static-take`, tree scope.

- It runs `ensureCrawlSnapshot` for every `crawlable` composition, which
  today is only `website`. This is the same function the build calls, so
  there is no second take path.
- **Cache:** it is keyed by `crawlSnapshotDirName`, through
  `cacheSignature()`. A push touching nothing the take reads replays.
  - A success publishes the artifact, so the following
    `./equin build --composition website` is a cache hit. The check costs
    nothing extra on the deploy path.
- **Failure:** the take's own error, which names the page, the path and the
  component stack, verbatim.
- **Cost gate:** measure a real take first (step 4). If a cold take costs
  more than about 60 s, make it `deploy` scope instead, so it runs in
  `build`/`push` but not in a bare `./equin check`, and record the reason in
  the check's description.
- **Copy from:** `migrations-in-sync`'s `drizzle-generate.ts` (spawns over
  staged sources; only a deterministic result is a verdict).

## Steps

1. **Static renderer on `SurfaceCore`.**
   - `static-renderer.tsx`: `StaticPane` becomes `StaticPaneCheck` (renders
     `null`). `renderPage` mounts `SurfaceCore` with it as `reporters`, and
     the app is looked up in `Apps.App`.
   - Fixture (`web/__tests__/static-renderer.test.tsx`): the site app
     contributes `Apps.App({ app, component: FixtureLayout })`. The fixture
     layout wraps `<FullPane />` in a context provider, and one pane reads
     that context.
   - New tests:
     - a pane reading layout-provided context renders (the regression);
     - an app with no `Apps.App` fails with `SurfaceCore`'s error;
     - a `SurfaceOverlay` inside the layout leaves no text in `html`.
   - Existing failure tests (unknown path, wrong pane, network, Suspense
     error) must keep passing unchanged.
   - Fix `SurfaceCore`'s stale embed comment, and update `static-render/CLAUDE.md`
     (the render path, the document rule, portals).
   - This step alone unblocks the website deploy.
2. **`Website.Layer` through `SurfaceOverlay`.**
   - `website-layout.tsx`: wrap `<Website.Layer.Render />` in
     `<SurfaceOverlay>`.
   - `consent-prompt.tsx` / `privacy.css`: the corner placement becomes a
     `Pin`.
   - Update the `Layer` doc in `shell/web/slots.ts` ("drawn in a surface
     overlay: never part of the static document").
3. **`crawlable:static-take` check** (`apps/website/crawlable/check/`), as in
   design §3, with a test that the signature equals `crawlSnapshotDirName`'s
   address.
4. **Measure, then pick the scope.** Run a cold take and a cached one, and
   record both times in this doc. Choose `tree` or `deploy` scope per §3.

## Verification

- `./equin test plugins/primitives/plugins/dom/plugins/static-render` covers
  the new and existing renderer tests.
- `./equin check` covers boundaries and cycles (the new
  `static-render → apps-core/tab-surface` edge), `type-check`, and the new
  check.
- `./equin build --composition website`: the crawl snapshot is taken (log
  `crawl snapshot website: taken in N ms`) and the build is deployed.
- In the snapshot's `/about` fragment, the demo band's caption ("equin,
  running entirely in your browser.") is present. The consent prompt's text
  ("We use cookies…") is absent.
- In the browser, at `http://website.localhost:9000/about`:
  - the consent prompt still shows in its corner on a fresh profile;
  - Enter equin starts the demo, and Maximize / Back keep it running across
    the page switch;
  - `register_before_after` on `/about` shows the prompt unchanged.
- Regression proof for the check: temporarily revert step 1 locally. The
  check must fail with today's `scoped-store` error, and pass again once the
  revert is undone.

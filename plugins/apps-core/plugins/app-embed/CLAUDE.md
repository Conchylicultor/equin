# app-embed

`<AppEmbed app? route? onLeave? fills? onTitleChange? className? />` renders the app in-process, inside
its own box: an **embedded tab set** (`apps-core/tabs`'s `TabsProvider
embedded={{ app, route, onLeave }}`) and the same surface body the app's own
layout renders (`Apps.Surface`, else the docked-only `AppTabsBody`). It knows
nothing about demos or data sources: around a `<DemoScope>` it renders a demo,
around nothing the real instance. Designs:
`research/2026-10-15-global-app-embed-and-agent-manager-demo.md` §2–§3,
`research/2026-11-04-global-desktop-mode-in-browser-demo.md`.

- **Its own tab set.** One tab at the place the page's URL names for it (an
  app-rooted URL resolved as its boundary resolves one — a surface-mode
  prefix, `/desktop/sonata`, opens that mode; one no app in scope owns opens
  the composition's home app), else of `app` at `route` (app-relative,
  `/c/<id>`), else on the composition's home app — in non-live pane stores: nothing inside reads or writes the page URL,
  history or sessionStorage, or publishes the page's signals (its surface
  mode, focused app and title, the live-store pointer, the navigator sink).
  The page's own tabs are untouched.
- **Its own navigation boundary** (the tab set's `AppNavBoundary`).
  Everything that reads it — `usePromote` (Expand), `useBack`, `useOpenPane`'s
  stranded routes, tabs' `useNavigate` / `useAppLink(Props)` / `useActivateApp`
  (the app brand, the launcher) — comes here, resolved over the `Apps.App` in
  scope:
  - an app in scope → the tab set's `navigate` (the tab's route, an in-tab app
    swap — the previous app is not kept alive — or, on the desktop, a window);
  - a surface-mode app's base path (`/desktop`, `/desktop/<route>`) → the
    embed's own mode switches (the Desktop: its windows are the embed's tabs,
    its layout the embed's — `apps/desktop/windows`' runtime per tab set);
  - anything else → `onLeave(url)`, by default a toast, and the embed stays.

  The policy is the scope: inside a `<DemoScope>`, `<PluginScope>` filters
  `Apps.App` to the composition. Nothing names the demo. A component that can
  render inside an embed reads navigation through those hooks, never the free
  `navigate` / `appLink` / `appLinkProps` (`tabs/no-free-app-nav-in-react`).
- **Its own theme scope**, the focused tab's app's, with `transform-gpu` so
  `position: fixed` app chrome resolves against the embed. The embed is its
  tab set's viewport (the set is `contained`): a `viewport`-framed placement
  (solo — a desktop window's Full screen) fills the embed box, and the embed
  still opens as a box, never in solo.
- **Its own overlays** (`Apps.Overlay`, mounted as the page's layout mounts
  them, inside its tab state): the floating launcher stands in for the rail
  and tab bar an embed never draws, so an app that draws no brand of its own
  is never a dead end in the box.
- **Keyboard.** Its tabs register their surface shortcuts (`mod+z`) like any
  tab; pointing at the embed claims the page's focused surface and tab set
  (`claimTabSet`), so shortcuts — the desktop's included — act on it.
  Mounting does not claim it: an embed inside a bigger page must not steal
  the keyboard from the page around it. An embed that is the page's whole
  surface says so — `fills="page"` (`/demo`, framed) or `fills="viewport"`
  (`/demo` full screen) — and takes the keyboard at mount, as the app's own
  surface does at boot, so Space reaches Sonata with no click first. A
  `viewport` one is no `floating-bar-boundary`: it is the viewport's
  top-right corner, so its headers make room for and anchor the page's
  floating action bar, as the app's own surface does.
- **Its place, in the page's URL — kept by the embed itself.** Where it is
  (the focused tab's app-rooted URL under the mode's prefix: `/agents/c/x`,
  `/desktop/sonata`) and whether its host maximized it are two reserved
  surface views of the enclosing pane instance (`pane/core`'s
  `EMBED_PLACE_SURFACE` / `EMBED_MAXIMIZED_SURFACE`), which the router
  spells as the URL's **embed tail**: `<the page's URL>/at/<location>[;full=1]`
  (`/demo/at/agents/c/x`, `/about/at/desktop/sonata;full=1`). So a host
  writes no URL code, every host spells it the same, and the tail rides every
  path a pane's URL rides (history snapshots, persisted tabs, restores).
  - Never a place no one chose: the place it opened at by itself (its seed,
    a redirect) is not written — the URL names a place once the user moves
    the embed (or maximizes it: `/demo;full=1`), so mounting an embed never
    rewrites its host page's address.
  - Framed, a move rewrites the current history entry (a box on a page: Back
    leaves the page); maximized, the embed is the tab, so each move is the
    entry the app's own tab would write (a link pushes, a redirect or a mode
    switch replaces), and Back / Forward move the embed back there (the
    embed follows its place when the URL changes under it).
  - `useEmbedPlace()` is the host's handle for its chrome: `maximized`,
    `setMaximized(on)` (the page's own step: a pushed entry, so Back from
    maximized returns to the frame) and `reset()` (forget the place — a
    demo's Reset, which may erase it).
  - One embed per pane instance (two would share the tail). Outside any pane
    (a test, an exhibit with no address) the place is kept in memory only.
  - The tail is written only on the route's last instance (its last slot, or
    the landing pane with no slot); elsewhere the two keys keep the plain
    `;view.embed=…` spelling. The parse tries the plain chain first, so a
    route with a real `at` segment (`/files/<fs>/at/…`) keeps meaning itself.
    Design: `research/2026-11-11-global-embed-place-in-page-url.md`.
- **Its new browser tabs.** A ⌘/middle-click or an Open in a new tab inside
  goes through `link-gesture`'s `openInBrowserTab`, whose address is the tab
  set the user is in's (`browserTabAddressSink`, installed by the page's tab
  set; an embed claims the set on pointer-down): this page with the embed at
  that place, maximized — the same embed (on a demo, the same data), never
  the real app at that path.
- **Its title, for the host to take.** `onTitleChange` is told the focused
  tab's title as the app's own tab is titled (`<Entity> — <App>`), and
  `undefined` when it unmounts; a host that is the embed while it shows
  hands it to its own tab (`tabs`' `useClaimTabTitle`).
- **Never its host page's scroll.** Its box is a reveal boundary
  (`scroll-reveal`): a reveal inside scrolls the embed's own containers.
- **Accepted leaks.** A native `<a href>` to an app path inside opens it on
  the host origin; DataView view state in `localStorage` is shared with the
  real app.

Tests: `web/__tests__/app-embed.test.tsx`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: <AppEmbed app? route? onLeave? fills? onTitleChange? />: the app rendered in-process inside its own box — an embedded tab set (TabsProvider embedded: seeded from the page URL's place, else app + route, else the composition's home app — non-live stores never touching the page URL, history or storage, none of the page's signals) and the same surface body the app's layout renders, so pane opens, app switches and the Desktop (its windows the embed's own tabs) work as in the app. Its navigation boundary resolves URLs against the apps in scope: an app's URL moves the embed, a surface-mode app's base path switches its mode, anything else is onLeave (default: a toast). Its theme scope is the focused tab's app's (transform-gpu, so fixed chrome stays in the embed); solo fills the embed box, and it opens docked. It keeps its own place in the page URL — the enclosing pane's embed tail, <the page URL>/at/<location>[;full=1] — so a host writes no URL code — never a place no one chose (nothing is written until the user moves it); framed, a move rewrites the current history entry; maximized, each move is the entry the app's own tab would write; Back / Forward move it back; a new browser tab opened inside opens this page there, maximized. useEmbedPlace() gives the host's chrome maximized / setMaximized (a pushed entry) / reset. fills: page | viewport: it is all the page shows (takes the keyboard at mount); a viewport-filling one hosts the page's floating action bar. Its box is a reveal boundary (a reveal inside never scrolls the host page), and onTitleChange hands the host its focused tab's title (<Entity> — <App>). Knows nothing about demos or where data comes from.
- Web:
  - Uses:
    - `apps-core.Apps`
    - `apps-core/tab-surface.AppTabsBody`
    - `apps-core/tabs.EmbeddedAt`
    - `apps-core/tabs.EmbeddedTabSet`
    - `apps-core/tabs.TabsProvider`
    - `apps-core/tabs.useTabs`
    - `primitives/css/theme-boundary.Theme`
    - `primitives/css/ui-kit.cn`
    - `primitives/dom/scroll-reveal.REVEAL_BOUNDARY_ATTR`
    - `primitives/error-boundary.PluginErrorBoundary`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/pane.HistoryMode`
    - `primitives/pane.usePaneViews`
    - `primitives/pane/route-prefix.withActiveRoutePrefix`
    - `primitives/scope/render-origin.RenderOrigin`
    - `primitives/slot-render.renderIsolated`
    - `shell/toast.showToast`
  - Exports (types):
    - `AppEmbedAt`
    - `AppEmbedLeave`
    - `EmbedPlace`
  - Exports (values):
    - `AppEmbed`
    - `useEmbedPlace`
- Cross-plugin:
  - Imported by:
    - `apps/demo/shell`
    - `apps/website/landing/screenshot`

<!-- AUTOGENERATED:END -->

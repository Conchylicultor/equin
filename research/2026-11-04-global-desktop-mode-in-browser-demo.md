# Desktop mode in the browser demo

Track: *apps running in the browser* (`block-d04c6c0d-…`), subtrack *portable server code*
(`block-323b766d-…`). Previous step: `research/2026-11-04-global-sonata-in-browser-demo.md`.
Task: task-1793813710-5fkaew.

## Context

`/demo` renders `<DemoScope scenario><AppEmbed app route/></DemoScope>`. `AppEmbed` shows ONE app
surface (a `SurfaceCore` over a non-live pane store) and swaps it on a cross-app hop. The desktop
(`apps/desktop`) is a *surface mode*. Its windows are the tabs of the page's ONE tab set
(`apps-core/tabs` `TabsProvider`), drawn by the `floating` placement of `apps-core/surface`'s
`SurfaceBody`. So inside the embed, the desktop resolves to no tab app and leaves: "Opens outside
this embed".

A second desktop on the page cannot be drawn today, because all of its state is page-global:

- **Tabs** (`use-tabs.tsx`): the surface mode, the navigator sink, the live-store pointer, the
  focused app, the focused tab's title, the route prefix, the history adapter, `surfaceEmpty`, and
  sessionStorage keyed by `appInstanceId()`.
- **Placement registry** (`placement-registry.ts`): one install sink that `SurfaceBody` writes.
- **Desktop windows** (`desktop/windows`): the window store (module maps persisted under
  `appInstanceId()`), the work-area reserve, the desk bounds, the minimise target, peek, overview,
  and the tabs bridge. Window commands and the 14 shortcuts are gated by the global
  `getSurfaceMode()`.

Rendering the desktop in the embed as things stand would drive the host's tabs and history, and it
would overwrite the host's window layout.

## Decision: a tab set is an instance

Rejected: a desktop-only special case in `AppEmbed`, and an iframe. The iframe document would
boot the host's own shell, so the same nesting problem would come back inside it, and it would
also join the host's session history.

### 1. `apps-core/tabs`: an embedded tab set

`TabsProvider({ embedded?: EmbeddedTabSet })`, where `EmbeddedTabSet = { app, route, onLeave }`.

- `TabsApi.id`: `"page"` for the page's set, `embed:<useId>` for an embedded one.
- **Embedded** boots one tab of `app` at `route`, from a seed and not from the URL.
  - Its stores are never live: no `setLiveStore`, and no URL or history.
  - It persists nothing, installs no history adapter, and writes no route prefix.
  - It publishes no page-global state: no navigator sink, `publishSurfaceMode`, `setFocusedApp`,
    focused-tab title or `surfaceEmpty`.
- It wraps its children in `AppNavBoundary` with its own navigator:
  - a URL of an app in scope goes to `navigate` (in-tab swap, or a new window in desktop mode);
  - a URL carrying a surface-mode app's prefix (`/desktop/…`) switches mode, then navigates the
    rest;
  - anything else goes to `onLeave`.
- **Per-instance placement registry.** `createPlacementRegistry()`. The page instance is the
  existing global sink, so the global readers (tab bar, theme scope, action bar) are unchanged.
  `TabsProvider` provides its registry by context, and `SurfaceBody`, `AppTabsBody` and the layout
  error surfaces register through `usePlacementRegistry()`. The `peek*` calls inside the provider
  read its own registry.
- **Focus.** The provider publishes `setFocusedSurfaceId` on every focus change, in both kinds; an
  embedded set skips the initial one at mount. `SurfaceBody`'s tab container also claims the
  focused surface on pointer-down, so keyboard scope follows the pointer between the host and the
  embed.
- **A keyed registry of mounted tab sets**: `id → { mode, tabs, api }`. It provides
  `tabSetOfSurface(surfaceId)` and `peekFocusedTabSet()`: the set holding the focused surface, else the
  set that last published focus, else the page's. Out-of-tree callers (shortcut `when` and handlers)
  use this instead of `getSurfaceMode()`.
- `useActivateApp`: a surface-mode app calls the context's `useTabs().setMode`, not the global one.
  Inside the embed, that is the embed's set.

### 2. `AppEmbed` hosts a tab set

`<TabsProvider embedded={{app, route, onLeave}}>` and then the same surface body the layout
chooses (the `Apps.Surface` contribution, else `AppTabsBody`). It keeps its theme box
(`transform-gpu`, `isolate`) and `data-app-embed` (the focused tab's app).

Cross-app hops are now the tab set's own `navigate` (an in-tab swap, as before). The session
machinery is deleted. Solo's `fixed inset-0` resolves against the embed box, because of
`transform-gpu`.

### 3. Desktop: a runtime per tab set

`desktop/windows` gets `DesktopRuntime`: the window store (windows, desktops, z, intro), the
work-area reserve, desk bounds, minimise target, peek, overview and tabs bridge. It is created per
tab-set id (`desktopRuntimeFor(id)`) and dropped when that set unmounts.

- Persistence: the page's runtime keeps its sessionStorage entry, keyed by `appInstanceId()`. An
  embedded runtime keeps nothing. Its layout lives only as long as the demo session.
- Hooks read `useDesktopRuntime()`, which is `desktopRuntimeFor(useTabs().id)`.
- Commands and shortcuts read `desktopRuntimeFor(peekFocusedTabSet().id)`.
- `peekDesktopActive()` / `useDesktopActive()` read the focused tab set's mode, or the context's.
- Transient pointer state (the snap preview, tab drag, the motion's `interacting`) stays
  page-global: there is one pointer per page.
- The launcher's "exit desktop" uses `useTabs().exitToPreviousMode`.

### 4. Server: what the desktop needs in the worker

- `desktop/shell/server` (the shelf config) is already portable.
- `desktop/wallpaper/server`:
  - The store moves onto a `data-files` root, `defineFileRoot` (the asset-mirror recipe). Desktop:
    `wallpaper/machine` binds it to `desktopDir`'s `wallpaper/`. Worker: memory.
  - Upload and the image route stay portable.
  - `import-url` (`safeFetch`, machine-only) moves to `machine/` and is declared
    `needsMachine: { feature: "Importing a wallpaper from a link" }`.
- The **Openverse** source (`safeFetch` to api.openverse.org) and the **From URL** source are
  excluded from `agent-manager-demo`. On the website a request must not leave the browser, and the
  computer is not there.
- Per-user state:
  - Pinned apps (`shelf`) and the wallpaper (`wallpaper`) are config_v2 documents. They are served
    by the worker's memory config store, seeded from the shipping layer.
  - Window layout lives in the embed's runtime.
  - Nothing is written to the host page's storage.

### 5. Composition and opening

`agent-manager-demo` adds `apps.desktop.**`, `!apps.desktop.wallpaper.openverse.**` and
`!apps.desktop.wallpaper.from-url.**`.

**The demo opens on the Agent Manager, and Desktop is a switch: the launcher's Desktop tile, as
on main.** Reasons:
- the demo's story opens on one conversation;
- floating windows in a small website band are cramped;
- the switch is the real app's own gesture, with no demo code.

A scenario can later open in desktop mode by seeding `route: "/desktop/…"` through the same
navigator.

## Verification

- Unit tests:
  - tabs: embedded boot, no URL or history writes, prefix → mode, `onLeave`;
  - app-embed: the existing tests, plus Desktop switching to floating with the URL untouched;
  - windows runtime: two runtimes isolated.
- `./equin build`: coverage guard green, no new exemptions.
- e2e: no-leak, app-switch, prototypes-in-demo and sonata-in-demo, plus the lumen boot test.
- New `apps/demo/e2e/desktop-in-demo.ts`:
  - launcher → Desktop: the embed is floating and the shelf shows;
  - open Pages and the Agent Manager as two windows;
  - the page stays `/demo`, the host's sessionStorage tab set is unchanged, and the host is not in
    desktop mode;
  - no request leaks.
- Desktop smoke on my build: `/desktop` with windows, shortcuts (⌘K, F3), a wallpaper upload, and a
  reload restoring the layout.

## Outcome (2026-11-04)

Landed as planned. A few points differ from the plan or add to it:

- **Naming.** Every one-shot sink read is spelled `peek…`, because `install-sink/no-laundered-peek` requires it: `peekFocusedTabSet()`, `peekFocusedDesktop()`, `peekDesktopActive()` (formerly `isDesktopActive`). The active tab set is an install sink with a fallback (`claimTabSet` installs the set).
- **Per-desktop overlay controls.** The launcher's open/close and the switcher's step are declared with `defineDesktopSink` (windows' web barrel), so each desktop's overlay answers only its own desktop.
- **The fullscreen control is optional.** A contained tab set has no `solo` placement, so the window offers no Full screen control there.
- **Wallpaper.** The store is a data-files root over the whole `apps/desktop` dir (`desktopFiles`, paths `wallpaper/current` and `.json`). `MAX_WALLPAPER_BYTES` moved to `core/`. Wallpaper's `no-platform-api` debt exemption is deleted. From URL stays in the demo and says "not available"; only Openverse is excluded.
- **Review fixes** (two Sonnet reviews):
  - when an embed unmounts while it holds the page's focused surface, it hands the surface back to the page's set;
  - focus is published by comparing against the last published tab, which makes the StrictMode re-run safe;
  - a dead link into an in-scope app goes to `onLeave` instead of throwing;
  - the windows under a drag (`interacting`) moved into the runtime, because window ids restart at `w1` in each desktop.
- **Found along the way:**
  - the token-usage docgen depended on scan batch composition (filed; fixed by task-1793827135-jz5xnx);
  - the sonata-in-demo sample counter sees 0 requests on a warm machine, on main too (task-1793831748-j1vosc).
- **Verification:**
  - desktop-in-demo 14/14 (new);
  - no-leak 31/31, app-switch 24/24, prototypes-in-demo 27/27;
  - sonata-in-demo 14/15 (the counter above);
  - lumen boot test passes;
  - apps-core and desktop unit tests 107/107. One flaky run of `tabs-store-legacy.test.ts` (untouched code) passed on re-run.

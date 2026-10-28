# Pane

Rationale (why each rule is so, rejected alternatives): [DESIGN.md](DESIGN.md) — read before changing or removing a rule.

One pane = one URL segment + one component.

- The runtime source of truth is the **route store**
  (`currentRoute: PaneSlot[]`), not the URL: the URL is derived, and the route
  is persisted in `history.state`.
- The route is layout-agnostic — a layout renderer (Miller, Full-pane) maps it
  to an arrangement.
- Each pane is self-contained: it gets `options` / a `hint` from its opener and
  self-fetches its data.

Core design: `research/2026-04-23-global-unified-pane-manager-v2.md`.

## Define a pane

```ts
// web/panes.tsx — each route sits immediately above the pane it names
const tasksRootRoute = defineRoute({ id: "tasks-root", segment: "tasks" });

const taskDetailRoute = defineRoute({
  id: "task-detail",
  segment: "t/:taskId",
  parent: tasksRootRoute,
});

export const taskDetailPane = Pane.define({
  route: taskDetailRoute,
  app: agentManagerApp, // mandatory — see "A pane's home app"
  component: TaskDetail,
  // required: the route's own segment has a `:param`
  useResolve: useResolveTask,
});
```

- **Register it**: `Pane.define` is a pure factory (`.useParams()`, `.link()`,
  `.useToggle()`, `.Actions`, …). A pane routes only once a
  `Pane.Register({ pane })` is in the plugin's `contributions` — unregistered
  compiles fine and never matches.
- **Where routes live**: same file by default.
  - Move one to `core/` only when something outside `web/` must build the link
    (a server `linkTo`, another plugin naming it as `parent`); that forces
    every ancestor route into `core/` too.
  - Never `export const xRoute = defineRoute(…)` in an `index.ts` (barrel
    purity).
- **`parent`** puts the ancestor's segment in the URL, types params as the
  **chained** set, and is the from-scratch ancestry.
  - It does NOT constrain where the pane can appear.
  - A pane with no real ancestor gets a parentless route — an invented parent
    adds a URL segment and a Miller column.
- **`segment`**: own URL fragment, no leading slash.
  - `:param`, `:rest*`, optional `:param?`; `""` = no segment of its own.
  - A bare leading `:param` throws (add a static prefix).
  - Uniqueness: `pane:segments-unique` check.
- **Optional `:param?`** must be the segment's last part (throws otherwise).
  - It addresses a VIEW of the entity (tab, stage): `proto/:name/:stage?`.
  - The parser takes the longer match, falls back to the shorter — but a next
    URL part belonging to a not-yet-loaded pane reads as the optional value.
  - Change it with `pane.useSetParams()`, not a `swap`.
- **Keyed params `;name`** (after the positional parts:
  `song/:songId/:bar?;lens;zoom`) — the unbounded form, for several views of
  one entity.
  - Optional keys, written as matrix params on the pane's LAST URL part
    (`/song/abc/12;lens=notation`), in declaration order, only when supplied.
  - Matrix, not `?query`, so each key is scoped to its pane in a multi-pane
    URL.
  - Undeclared keys are dropped; a pane with no keyed params reads a raw `;` as
    text.
  - They don't change collision shape and don't count as "paramful" for
    `useResolve`.
- **Surface view keys `;view.<surface>`** — every pane carries them undeclared
  (`surfaceViewKey(surface)`, core; grammar `[A-Za-z0-9._-]+`): which view of
  one surface (e.g. a DataView, keyed by its id) is on screen.
  - Example: `/tasks;view.tasks-list=open`. Written after declared keys,
    sorted.
  - `defineRoute` throws on a declared `;view` or `:view`.
  - They are NOT typed params: `useParams()`, `useResolve`,
    `MatchEntry.params` / `fullParams` never carry them (the entry's `views`
    does); opens never supply them; `RouteDef.path` never writes them;
    `useSetParams` preserves them.
  - Only `fillSegment(…, { ownSlot: true })` writes them.
  - A pane with no keyed params strips only a trailing run of
    `;view.<surface>=…` (and a retired bare `;view=…`).
- **The index pane carries them on the base path**:
  `/sonata;view.sonata.library=all`. It is not a slot, so its keyed params live
  beside the route in the store (`getIndexParams()`):
  - parsed off a leading `;…` (`parseUrl` → `index`);
  - saved in `history.state` as `index`;
  - carried by `navigate()` / boot;
  - dropped by a navigation that doesn't pass them
    (`setRoute(route, replace, index)`).

  A non-index pane with no URL part of its own cannot carry them.
- **`useResolve`** is required exactly when the route's own segment has a
  `:param`, forbidden otherwise; opt out with `useResolve: false`.
  - It is a hook (`Hook<…>` brand, `primitives/hook-value`) returning a
    `ResolveResult`: `pending` / `error` (optional `retry`) / `missing` /
    `found`.
  - Over a live read use `resolveFrom(result, isFound)`, over `useLiveRow`
    `resolveRow(row)`.
  - The guard paints Loading / error with Retry / Not Found; once `found` it
    stays mounted through later `pending`/`error` (only `missing` unmounts).
  - Never answer `found` or `pending` for a failed read.
- **`width`** — default Miller column width (px, default 400); the last column
  flex-grows.

### `usePaneViewParam` — the view on screen, in the URL

`usePaneViewParam(surface)` → `{ value, set }` for the enclosing pane's
`;view.<surface>` (index pane included), or `null` outside a pane / where no
address can hold it.

- `set` **replaces** the history entry (a view switch is not a navigation).
- `set(undefined)` removes the key.
- DataView binds it automatically (data-view CLAUDE.md, "Addressable views").

## Read params

`pane.useParams()` is **own-only** — only this pane's `segment` params. Read an
ancestor's with `ancestorPane.useParams()`.

## Query the route from outside a pane

The match belongs to the **surface**: `PaneSurfaceProvider` resolves it once,
so sidebar, toolbar and body read the same match.

- `pane.useRouteEntry()` (first or `null`) / `pane.useRouteEntries()`
  (multi-instance panes) → `{ instanceId, params, fullParams }`; pass
  `instanceId` to `pane.close()`. Don't reach into `_internal` /
  `usePaneMatch()`.
- `pane.useOpenedHere()` — **which instance did I open?** (first entry for this
  pane after the caller's own pane).
  - Use it for opener toggles; "last entry" heuristics are wrong.
  - `useRouteEntries()` only when the question is about the whole chain.
- **Outside every surface** (global chrome: `Core.Root` action bar,
  `Apps.TabBarActions`, their popovers) the route-read hooks **throw** — `null`
  is only the in-surface "not in the route". Use `useTabs()` / `navigate()`
  from `@plugins/apps-core/plugins/tabs/web` there.
- Exceptions legal everywhere:
  - `useOpenPane` (below);
  - `useOpenedHere()`, which returns `null` outside a surface (nothing opened
    there is "here"), so reusable opener widgets work in popovers too.

## Non-URL state: `options` and `hint`

Exactly two kinds, decided by: **does the value have a canonical server-side
owner?**

|                    | `options`                                 | `hint`                  |
| ------------------ | ----------------------------------------- | ----------------------- |
| Canonical owner    | none — the pane owns it                   | a live-state resource   |
| Absence means      | the declared default                      | wait for canonical      |
| Persisted          | yes (`history.state`, tabs, pane-restore) | **never**               |
| Read as            | `useOptions()` → **total** `Options`      | `useHint()` → `Hint<T>` |
| Safe to write back | UI config; nothing writes it              | **never**               |

A value already in the URL (incl. ancestor params) is read from the route, not
either.

**`options`** — declare the defaults (= the deep-link value); callers pass a
partial override.

- `useOptions()` is total (nothing to `??`).
- A pane with no `options` rejects them at the call site.

```ts
Pane.define({
  route: fileRoute,
  app,
  component: FileBody,
  options: { compact: false },
  useResolve: useResolveFile,
});

openPane(filePane, { path }, { mode: "push", options: { compact: true } });
```

**`hint`** — optimistic pre-paint of server-owned state.

- Absent on every rebuilt route (deep link, reload, back/forward), possibly
  stale.
- `Hint` holds no data: `pick(key, canonical)` is the only accessor and
  requires the canonical value.

```ts
Pane.define({
  …,
  hint: type<{ title: string }>(),
  title: { useText: useSongTitle },
});

openPane(
  sonataPlayerPane,
  { songId },
  { mode: "root", hint: { title: song.title } },
);

function useSongTitle(params, hint) {
  // …
  return hint.pick("title", canonical); // canonical wins
}
```

- `lint/no-hint-fabrication` bans `pick(…) ?? "Untitled"` and
  `pick("title", undefined)`; `?? null` or `?? <Placeholder>…</…>` are fine.
- If an option's default would be a lie about server state
  (`options: { title: "Untitled" }`), it is a hint, not an option.

Why: `research/2026-07-10-global-pane-input-hint-vs-options.md`.

## Navigate

No `pane.open()`. Two forms, both taking the **full ancestor + own** params:

- **`openPane`** (module-level) — targets the live store; type accepts **only**
  `{ mode: "root" }` (no caller position).
- **`useOpenPane()`** — caller-aware, all modes. **Legal everywhere**: resolves
  the surface's store, else the **focused tab's** store, at click time.

Also on `PaneObject`:

- `link(app, params)` (URL, no navigation), `useToggle(params, opts)`.
- `close(instanceId)` (to parent), `unwrap` (remove, keep children), `promote`
  (make root), `back()` / `forward()`, hook forms `useClose()` /
  `usePromote()`.
- `useSetParams()` rewrites THIS instance's own params in place (no remount;
  keeps collapse/options/right-hand panes) — pass the whole own set; for
  `:param?` / `;name` view switches. A different entity is a `swap` (fresh
  instance).

**A control that opens a pane spreads `openPane.link(pane, params, opts)`**,
not an `onClick` (`link-gesture/no-click-navigate` enforces; also
`openPane.to(…)`):

```tsx
<Button {...openPane.link(traceDetailPane, { id }, { mode: "push" })}>
  Open trace
</Button>
```

- Plain click opens; ⌘/Ctrl/middle-click opens the URL plain click *would*
  produce in a new browser tab.
- Both run one pure
  `computeOpen(currentRoute, callerInstanceId, target, params, opts)` — the
  only implementation of the modes (shared with `store.openPaneImpl` and
  `promote`).
- `store.routeUrl(route)` is a route's base-path-prefixed URL.
- `hint` and `options` don't survive a new tab — link state belongs in a URL
  param.

Modes:

- `"root"` — replace the route with a fresh one rooted at the target (rebuilt
  from its parent chain).
- `"push"`:
  - `side: "right"` (default) appends after the caller, truncating to its
    right;
  - `side: "left"` inserts before the caller — **unless the target is already
    an ancestor**, then it falls through to a right-push (duplicates it on the
    right).
- `"swap"` — replace the caller's slot (same pane type), truncating children.
- `"append"` — after the route's LAST pane, replacing it when it's the same
  pane type. The positional open for global chrome (no caller).

With no caller pane, `push` / `swap` are **not** `root`: they first look for
the target in the route —

1. same params+options ⇒ no-op;
2. else replace that slot and truncate after it;
3. only if absent rebuild from the parent chain.

## Chrome

**Every pane wraps its body in `<PaneChrome pane={…}>`** — no opt-out.

- It always renders a header `Bar` (or the same row as a card,
  `header="card"`) plus exactly one body scroll (`PaneScroll`).
- The header is ONE overflow-collapsing slot (`pane.Actions`), then promote and
  × close (only at `depth > 0`).
- A rich header is just more items in that slot.

### The title (`Pane.define({ title })`)

Declared once on the definition — the single source for tab label, document
title and the header title item. `PaneChrome` takes no title or header content.

```tsx
Pane.define({ …, title: "Settings" }); // = { useText: "Settings" }

Pane.define({
  …,
  title: {
    // string | (params, hint, options) => string | undefined
    useText: usePageTitle,
    // string | (params) => string, while useText is undefined
    fallback: (p) => p.pageId,
    component: PageTitleTrail, // optional rich HEADER-only title
  },
});
```

- **`useText`** hook runs **outside** the app's providers (at the tab surface,
  also for background tabs):
  - read only its args (chained params, hint, options) and global hooks (live
    resources), never app-local context;
  - return `undefined` while unknown.
- **`fallback`**: generic noun or URL-derived — never a fabricated entity name.
- **`component`**: mounted inside the pane (may use `pane.useParams()`, app
  context, be interactive); tab/document titles still use
  `useText`/`fallback`, so declare both.
- Resolution is `usePaneTitle` (`useText` → `fallback` → nothing), shared by
  tab reporter, collapsed Miller column and header.

#### No side door into the header row

The header row is ONE slot, `pane.Actions`; the title is one item. No prop
passes header content (`title` / `extra` / `headerSpill` are gone).

- A `title.component` may not render a render slot: a slot list middleware
  **throws** ("A render slot mounted inside the pane title…") into the title
  item's error boundary.
- Plain and dispatch slots inside a title (a breadcrumb separator) are allowed.

#### Tab / document title ownership (`titleOwner`)

The tab/document title comes from the route's **title owner**: the FIRST pane
declaring `titleOwner: true` — a main surface whose entity is the page's
identity (conversation, task, page, song), not a nav list or aux tool pane.

- No owner ⇒ leaf pane, then app index pane, then app name.
- A `titleOwner` needs a resolving title (`useText` or `fallback`), or the tab
  pins to the app name.

#### Title typography is container-owned

The title item wraps string or `component` in `<Text variant="label">`
(`pane-title.tsx`). A title component **must not set its own text size**
(weight/color may compose). Enforced by `lint/no-adhoc-pane-title`.

### `PaneScroll` — the sanctioned pane-body scroll viewport

**A pane body is exactly one `PaneScroll`; every header inside it is a
`<Sticky>`** (`@plugins/primitives/plugins/css/plugins/sticky/web`).
PaneChrome already routes the body through it, so don't put `overflow-*` on the
body root:

- Simple content → nothing to do.
- Header + scrollable body → root `flex h-full flex-col`, inner region a
  `<PaneScroll>`.
- Custom viewport (terminal, canvas) → root `h-full` (`overflow-hidden` OK).

It forwards `ref` and `Scroll`'s props (`hideScrollbar`, `isolate`, `as`,
`className`).

### `PaneChrome` props

- **`overlay={…}`** — non-scrolling widgets (outline rail, progress card),
  sibling of the scroll in a `relative isolate` host.
  - Don't wrap `PaneChrome` in your own `relative` host — it spans the header
    and corner overlays land on its actions.
- **`ground={…}`** — non-scrolling backdrop filling the body box (behind the
  scroll); owns its look and `aria-hidden`.
- **`floatingHeader`** — header moves inside the scroll, pinned: see-through at
  top, masked once content scrolls under.
  - Only for pages designed to show through the header.
  - `overlay` then spans the header too.
  - Goes with `headerTheme` (a `subThemeScope(…)`, may change on scroll; mask
    republished as `--chrome-mask`) and `headerGlass` (frosted mask).
- **`inset="content"`** — aligns a DataView toolbar and content on ONE
  pane-relative edge (below). Default `"chrome"`.
- **`header="card"`** — same header row as a floating card (below). Excludes
  `floatingHeader` / `headerTheme` / `headerGlass` (type error).
- **`titleOnly`** — only the title cell; the host paints its actions in its
  content.

### `inset="content"`

What it does:

- The pane root becomes an inline-size container (so `cqi` is a fraction of
  the pane).
- It publishes `--pane-inset: var(--content-inset)` (density group's
  `contentInset` token), and every `rail-follow` band in the body floors at it
  ([`rail`](../css/plugins/rail/CLAUDE.md)).
- The header title stays on `chromePanePadStart`/`End`.
- Unset `contentInset` ⇒ looks like any other pane.

Why opt-in: a container is the containing block for `position: fixed`
descendants (un-portaled `fixed` is clipped — `findViewportBlocker` names it)
and the nearest container for unnamed `@container` / `cq*`; the root must sit
in a sized box.

Tokens and parts:

- `chromePaneH` / `chromePaneRule` are per theme scope (affect every header of
  the app); card rows use `chromePaneCardH` /
  `chromePaneCardPadStart`/`End`.
- Header row is `data-part="pane.header"`, title box `data-part="pane.title"`.

### `header="card"`

Draws the same row (leading control, Back, the `Actions` slot, promote, close)
as a content-sized `<Surface level="float">` pinned top-left over the body; the
body gets the whole height (edge-to-edge canvases, e.g. the prototype viewer).

- Not an `AdaptiveBar`: no `⋯`, each item its own box
  (`SlotItemLayout orientation="host-owned"`).
- Only the title (`cell: "yield"`) gives (ellipsizes at the cap = pane width
  less inset).
- An item that should vanish on narrow windows hides itself.

### The header slot (`Actions`)

Each pane auto-creates an `Actions` slot
(`taskDetailPane.Actions({ id, component })`) — the WHOLE header row, title
included: one `defineRenderSlot<PaneHeaderItem>`, one reorder directive, one
`⋯`.

- A `PaneHeaderItem` has exactly one renderable form: `component`, or
  `onClick` + `label`/`icon`.
  - No `position`: order/hiding/grouping is the reorder config.
  - A leading/trailing split is a `{ "type": "spacer" }` node (without one,
    items pack trailing).
- **`id` is required and stable** (kebab-case, `"view-mode"`) — it keys the
  [`AdaptiveBar`](../adaptive-bar/CLAUDE.md) width ledger; a churning id throws
  away every measurement.
- Ghost icon button: `<PaneIconAction label icon onClick>` (forwards refs).
- A popover trigger:
  `<PopoverTrigger className={buttonVariants({ variant: "ghost", size: "icon" })}>`
  (Base UI triggers take no `asChild`).
- **Nobody re-contributes a title**: `pane` contributes one `title` item
  (`primitives.pane:title`) into every header, minted per declared header slot
  by the slot-declaration pass (`web/header-slot.ts`).
  - It sits in the **yielding cell** (`cell: "yield"`: unmeasured, `min-w-0`,
    takes leftover space).
  - `cell` is generic, at most one per header (the bar throws on a second).
  - Hiding the title item leaves the tab title alone.
- Overflow: items are `AdaptiveBar` occupants — asked for a smaller form, then
  **moved** (same live element) behind `⋯`.
  - No `position: sticky` inside an item.
  - An item holding an `<iframe>` refuses to relocate.
- Hand-rolling a `border-b` header bar in a pane body is banned
  (`no-adhoc-pane-toolbar`) — contribute to the header.

### Hiding the close / promote buttons

- `chrome: { close: false }` when close has no meaningful destination.
- `chrome: { promote: false }` for compact side-panels with their own expand
  action.

### A header shared by several panes (`Pane.define({ actions })`)

```ts
export const WebsiteHeader = definePaneHeaderSlot(); // in the owning plugin

slots: { ...Website, header: WebsiteHeader } // declared ONCE, own key

WebsiteHeader({ id: "download", component: DownloadNavItem });

// pane.Actions IS that slot
export const downloadsPane = Pane.define({ …, actions: WebsiteHeader });
```

- No borrowing pane (not even the owner's) is listed in a `slots:` record — the
  declaration pass rejects "one slot is declared under two keys".
- One title item, painting whichever pane's `PaneChrome` renders it.
- `definePaneHeaderSlot()` owns `docLabel` and optional `controlSize`;
  `Pane.define` mints through it too.

## Router

Navigation (`openPane`, `useOpenPane()`, `restoreRoute`):

1. mutates the route store;
2. derives the URL (`buildRouteUrl()`);
3. emits a `{ url, state, mode }` intent through the installed
   `HistoryAdapter` (`history-sink.ts`) — the store never touches
   `window.history`.

`state` is the serialized route (paneId, params, options — never `hint`) or
`{ pending }`. The shell mounts one layout renderer, which reads `useRoute()`;
the lookup table rebuilds from `Pane.Register` via `useSyncPaneRegistry()`.

### The `HistoryAdapter` seam

- `commit(change)` writes URL + history entry and announces `shell:navigate`
  (never a synthetic `popstate`).
- `restore()` runs only on real back/forward (the one `popstate` listener).
- Programmatic ⇒ `shell:navigate`; traversal ⇒ `popstate` — a hard contract,
  not comparison.
- The adapter lives in an
  [`install-sink`](../scope/plugins/install-sink/CLAUDE.md) defaulting to
  `defaultHistoryAdapter` (standalone/tests; `setHistoryAdapter` returns a
  disposer restoring it).
- The tabs layer installs an app-aware adapter storing
  `{ tabId, appId, appInstance, route | pending }` snapshots (see tabs
  `CLAUDE.md`); `handleLocationChange` reads only `route`/`pending`, so the
  pane store never learns about tabs.
- `parseUrl` is only the fallback for initial load, shared deep links, and
  entries with no snapshot.

### The address bar is untrusted input

Read the route path only via **`currentRoutePath()`** (`pane/web`), which
canonicalizes through `normalizeRoutePath()` (`pane/core`: collapse `/` runs,
one leading `/`).

A raw `//agents/c/x`:

- is scheme-relative as a history URL (`replaceState` throws `SecurityError` —
  a boot crash);
- misses as a match key (falls back to the default app).

Enforced by `pane/no-raw-location-path`.

## Testing

Run with `./equin test plugins/primitives/plugins/pane` (jsdom suites in
`web/__tests__/`). **Mount a surface with `TestSurface`** from
`@plugins/primitives/plugins/pane/web/testing` — never hand-pick contexts:

```tsx
const store = createTestSurfaceStore(); // in beforeEach

render(
  <TestSurface store={store} plugins={[testPlugin]}>
    <ComponentUnderTest />
  </TestSurface>,
);
```

- A store is not optional: `PaneStoreContext` has no default, so any route hook
  (incl. Loading/Not-Found chrome via `useClose()`/`usePromote()`) throws
  without one.
- `live: true` (default) for URL-derived cases — `handleLocationChange` ignores
  a background store. Pass `{ live: false }` when restoring a route by hand
  that must not be re-parsed from the URL.
- Suites that only drive a `PaneStore` object need no surface.

## A pane's home app, and what Expand means

`Pane.define({ app })` names the app a pane **belongs to**, not where it
renders.

- **Mandatory, no opt-out** (the theme customizer's home is still
  `settingsApp`).
- Write it right after `route:`, importing the `AppRef` from the app shell's
  **core** barrel (`@plugins/apps/plugins/<app>/plugins/shell/core`, a
  cycle-free leaf).
- Test fixtures `defineApp` a local app (no dependency on `plugins/apps`).
- `AppRef.name` is the single source of the app's display name (rail tooltip,
  tab fallback, Expand).

Expand (`usePromote()`) returns a discriminated `PromoteAction`:

- `{ kind: "cross-app"; app; open; href }` — hosted by another app: hand its
  app-rooted URL to the tab manager. Offered even at position 0. Label
  "Open in <App>".
- `{ kind: "re-root"; open; href }` — own app: drop ancestors, re-root here
  (below root only). Label "Expand pane".
- `null` — no button.

The button spreads `linkProps(promote)`.

Cross-app needs an installed navigator and a buildable URL (a paramful
ancestor missing from the route ⇒ none); either missing degrades silently to
the same-app branch.

### A route belongs to its root pane's app

A guest is hosted **beside** a host pane, never as the head of the host's
route. `routeHomeApp(route)` = the root pane's home; every way onto a surface
enforces it:

- **Opening** — when the computed route's head belongs to another app,
  `useOpenPane()` / `openPane()` hand the same route, rooted at that app, to
  the cross-app navigator (an embed's `AppNavBoundary` first); the link's href
  is that URL.
  - So `openPane.link(settingsPane, {}, { mode: "root" })` is right from any
    app.
  - No navigator installed ⇒ throws.
- **Arriving by URL** — the tab manager moves the focused tab to the route's
  app, replacing the entry (`apps-core/tabs`).

Expand's re-root obeys it too (in place only for this app's panes).

**Navigation sink**: `apps-core/tabs` imports this primitive, so it installs
its `navigate` into `appNavSink` (`app-nav-sink.ts`), an
[`install-sink`](../scope/plugins/install-sink/CLAUDE.md). Read it with
`appNavSink.useInstalled()` in render; `peek…` only in handlers/effects.

### A pane wears its home app's theme

`PaneBox` stamps `data-theme-scope="app:<home app id>"` (forwarded across
portals; collapsed Miller columns too).

- Only the tag lives here: an app with a forked theme emits a matching block
  (theme-engine); an unforked app emits none, so its guest panes inherit
  `:root` (the host's look).
- Light/dark is one `<html>.dark` per document, so a pane's scope never
  switches color mode — a surface needing its own scheme is an app, not a
  pane.

### The app's index pane (`appIndex`)

`appIndex: true` marks the app's landing pane — what the bare base path shows
with an empty route.

- Its route has `segment: ""`; registry sync throws on a segment-bearing index
  pane or a second index per app.
- No global fallback: no index pane ⇒ empty main area (legitimate: `home`,
  `studio`).
- `useIndexMatch(basePath)` resolves it; the main renderer paints it only for
  an empty route, overlay hosts ignore it.

### Companion panes (`companion`)

`companion: true` = accompanies what's on screen (an attachment preview).

- As the route's HEAD, the match (`usePaneRoute`) keeps the index pane to its
  left (URL unchanged; tab keeps the index title; `useClose()` empties the
  route).
- Deeper in a route it's an ordinary pane.
- A pane opened FROM the index still replaces it.

## Not yet implemented (deferred)

- `keepalive` for heavy panes — switching slots remounts.
- Layout tree (drag-and-drop, tabs, overlays).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Unified pane primitive: Pane.define and chrome components.
- Load-bearing: yes
- Web:
  - Slots: `Pane.Register`
  - Slot contributors: 93 contributors — full list in [REFERENCE.md](./REFERENCE.md)
    - `Pane.Register` ×93
  - Contributes: 121 contributions — full list in [REFERENCE.md](./REFERENCE.md)
    - `SlotRender.ListMiddleware`
    - `WebsiteHeader` "title" → `PaneTitleItem`
    - `accountPane.Actions` "title" → `PaneTitleItem`
    - `accountsPane.Actions` "title" → `PaneTitleItem`
    - `agentDetailPane.Actions` "title" → `PaneTitleItem`
    - `agentReportPane.Actions` "title" → `PaneTitleItem`
    - `agentSidePane.Actions` "title" → `PaneTitleItem`
    - `agentsRootPane.Actions` "title" → `PaneTitleItem`
    - `allConversationsPane.Actions` "title" → `PaneTitleItem`
    - `app-preview.actions` "title" → `PaneTitleItem`
    - `attachmentPreviewPane.Actions` "title" → `PaneTitleItem`
    - `attemptPane.Actions` "title" → `PaneTitleItem`
    - `automation-detail.actions` "title" → `PaneTitleItem`
    - `automations.actions` "title" → `PaneTitleItem`
    - `background.actions` "title" → `PaneTitleItem`
    - `backgroundEntryPane.Actions` "title" → `PaneTitleItem`
    - `backupPane.Actions` "title" → `PaneTitleItem`
    - `backupRunPane.Actions` "title" → `PaneTitleItem`
    - `blockDetailPane.Actions` "title" → `PaneTitleItem`
    - `broadcastsPane.Actions` "title" → `PaneTitleItem`
    - `buildDetailPane.Actions` "title" → `PaneTitleItem`
    - `buildPane.Actions` "title" → `PaneTitleItem`
    - `buildProfileDetailPane.Actions` "title" → `PaneTitleItem`
    - `chord-trainer.actions` "title" → `PaneTitleItem`
    - `claudeCliCallDetailPane.Actions` "title" → `PaneTitleItem`
    - `claudeCliCallsPane.Actions` "title" → `PaneTitleItem`
    - `commitDetailPane.Actions` "title" → `PaneTitleItem`
    - `comparePane.Actions` "title" → `PaneTitleItem`
    - `compositionDetailPane.Actions` "title" → `PaneTitleItem`
    - `compositionsPane.Actions` "title" → `PaneTitleItem`
    - `configDetailPane.Actions` "title" → `PaneTitleItem`
    - `configNavPane.Actions` "title" → `PaneTitleItem`
    - `configOrphansPane.Actions` "title" → `PaneTitleItem`
    - `contributions.actions` "title" → `PaneTitleItem`
    - `conv-commits-graph.actions` "title" → `PaneTitleItem`
    - `conv-file-tree.actions` "title" → `PaneTitleItem`
    - `conv-push-profiling.actions` "title" → `PaneTitleItem`
    - `conv-summary.actions` "title" → `PaneTitleItem`
    - `convReviewPane.Actions` "title" → `PaneTitleItem`
    - `conversationPane.Actions` "title" → `PaneTitleItem`
    - `debug-boot-profile-detail.actions` "title" → `PaneTitleItem`
    - `debug-boot-profile.actions` "title" → `PaneTitleItem`
    - `debug-boot-profiles-list.actions` "title" → `PaneTitleItem`
    - `dependencies.actions` "title" → `PaneTitleItem`
    - `deploymentDetailPane.Actions` "title" → `PaneTitleItem`
    - `eventListPane.Actions` "title" → `PaneTitleItem`
    - `eventSourceDetailPane.Actions` "title" → `PaneTitleItem`
    - `eventSourceRunPane.Actions` "title" → `PaneTitleItem`
    - `eventSourcesPane.Actions` "title" → `PaneTitleItem`
    - `events-root.actions` "title" → `PaneTitleItem`
    - `eventsTestPane.Actions` "title" → `PaneTitleItem`
    - `exhibit-stage.actions` "title" → `PaneTitleItem`
    - `exhibit.actions` "title" → `PaneTitleItem`
    - `exhibits.actions` "title" → `PaneTitleItem`
    - `explorerPane.Actions` "title" → `PaneTitleItem`
    - `filePeekPane.Actions` "title" → `PaneTitleItem`
    - `files-data-at.actions` "title" → `PaneTitleItem`
    - `files-data.actions` "title" → `PaneTitleItem`
    - `filesAtPane.Actions` "title" → `PaneTitleItem`
    - `filesHomePane.Actions` "title" → `PaneTitleItem`
    - `graphCanvasPane.Actions` "title" → `PaneTitleItem`
    - `healthMonitorPane.Actions` "title" → `PaneTitleItem`
    - `heapSnapshotPane.Actions` "title" → `PaneTitleItem`
    - `homeRootPane.Actions` "title" → `PaneTitleItem`
    - `icons.actions` "title" → `PaneTitleItem`
    - `liveStateEmitPane.Actions` "title" → `PaneTitleItem`
    - `liveStateHealthPane.Actions` "title" → `PaneTitleItem`
    - `logChannelPane.Actions` "title" → `PaneTitleItem`
    - `logsPane.Actions` "title" → `PaneTitleItem`
    - `mail-message.actions` "title" → `PaneTitleItem`
    - `mail-root.actions` "title" → `PaneTitleItem`
    - `mail-search.actions` "title" → `PaneTitleItem`
    - `mailThreadsPane.Actions` "title" → `PaneTitleItem`
    - `mcp-tool.actions` "title" → `PaneTitleItem`
    - `mcp-tools.actions` "title" → `PaneTitleItem`
    - `memoryPane.Actions` "title" → `PaneTitleItem`
    - `newAppPane.Actions` "title" → `PaneTitleItem`
    - `notifications.actions` "title" → `PaneTitleItem`
    - `opDetailPane.Actions` "title" → `PaneTitleItem`
    - `pageDetailPane.Actions` "title" → `PaneTitleItem`
    - `pages-root.actions` "title" → `PaneTitleItem`
    - `pagesTreePane.Actions` "title" → `PaneTitleItem`
    - `places-map.actions` "title" → `PaneTitleItem`
    - `plugin-conv-side.actions` "title" → `PaneTitleItem`
    - `pluginViewPane.Actions` "title" → `PaneTitleItem`
    - `profilingPane.Actions` "title" → `PaneTitleItem`
    - `prototypeDetailPane.Actions` "title" → `PaneTitleItem`
    - `prototypes-present.actions` "title" → `PaneTitleItem`
    - `prototypesGalleryPane.Actions` "title" → `PaneTitleItem`
    - `queue-dead.actions` "title" → `PaneTitleItem`
    - `queue-emission.actions` "title" → `PaneTitleItem`
    - `queue-job.actions` "title" → `PaneTitleItem`
    - `queue-trigger.actions` "title" → `PaneTitleItem`
    - `queuePane.Actions` "title" → `PaneTitleItem`
    - `readSetPane.Actions` "title" → `PaneTitleItem`
    - `recoveryPane.Actions` "title" → `PaneTitleItem`
    - `releaseDetailPane.Actions` "title" → `PaneTitleItem`
    - `renderProfilerPane.Actions` "title" → `PaneTitleItem`
    - `reportDetailPane.Actions` "title" → `PaneTitleItem`
    - `reportsPane.Actions` "title" → `PaneTitleItem`
    - `screenshotPane.Actions` "title" → `PaneTitleItem`
    - `serverDetailPane.Actions` "title" → `PaneTitleItem`
    - `serversRootPane.Actions` "title" → `PaneTitleItem`
    - `settings-config-index.actions` "title" → `PaneTitleItem`
    - `settings-profile.actions` "title" → `PaneTitleItem`
    - `shellOutputPane.Actions` "title" → `PaneTitleItem`
    - `slow-op-detail.actions` "title" → `PaneTitleItem`
    - `slowEventsPane.Actions` "title" → `PaneTitleItem`
    - `sonataLibraryPane.Actions` "title" → `PaneTitleItem`
    - `sonataPlayerPane.Actions` "title" → `PaneTitleItem`
    - `statsPane.Actions` "title" → `PaneTitleItem`
    - `systemAgentDetailPane.Actions` "title" → `PaneTitleItem`
    - `tableDetailPane.Actions` "title" → `PaneTitleItem`
    - `taskDetailPane.Actions` "title" → `PaneTitleItem`
    - `tasksRootPane.Actions` "title" → `PaneTitleItem`
    - `themeCustomizerPane.Actions` "title" → `PaneTitleItem`
    - `threadPane.Actions` "title" → `PaneTitleItem`
    - `traceDetailPane.Actions` "title" → `PaneTitleItem`
    - `welcomePane.Actions` "title" → `PaneTitleItem`
    - `workflow-node.actions` "title" → `PaneTitleItem`
    - `worktreeCleanupPane.Actions` "title" → `PaneTitleItem`
  - Uses: 39 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×4
    - `primitives/slot-render` ×4
    - `primitives/live-state` ×3
    - `primitives/css/scroll` ×2
    - `primitives/link-gesture` ×2
    - `primitives/adaptive-bar.AdaptiveBar`
    - `primitives/bar.Bar`
    - `primitives/css/center.Center`
    - `primitives/css/column.Column`
    - `primitives/css/line.Line`
    - `primitives/css/overlay.Overlay`
    - `primitives/css/pin.Pin`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/spacing.Stack`
    - `primitives/css/sticky.Sticky`
    - `primitives/css/surface.Surface`
    - `primitives/css/text.Text`
    - `primitives/css/theme-boundary.Theme`
    - `primitives/css/yield.yieldClass`
    - `primitives/dom/in-view.useInView`
    - `primitives/hover-reveal.hoverRevealGroup`
    - `primitives/icon-button.IconButton`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/loading.Loading`
    - `primitives/pane/route-prefix.splitRoutePrefix`
    - `primitives/scope/install-sink.defineInstallSink`
    - `primitives/scope/surface-id.SurfaceIdContext`
    - `primitives/select-scope.ContentScope`
    - `ui/icons.Icon`
  - Exports (types):
    - `AnyPane`
    - `AppNavigator`
    - `Hint`
    - `HistoryAdapter`
    - `LocationChange`
    - `MatchEntry`
    - `OpenPaneFn`
    - `PaneChromeConfig`
    - `PaneHeaderAction`
    - `PaneHeaderComponent`
    - `PaneHeaderItem`
    - `PaneHeaderSlot`
    - `PaneHeaderSlotOptions`
    - `PaneHistoryState`
    - `PaneInternal`
    - `PaneMatch`
    - `PaneObject`
    - `PaneOpenMode`
    - `PaneOptions`
    - `PaneRouteEntry`
    - `PaneScrollProps`
    - `PaneSlot`
    - `PaneStore`
    - `PaneTitleHook`
    - `PaneTitleSpec`
    - `PaneToggleOpts`
    - `ParsedRoute`
    - `PromoteAction`
    - `ResolveHook`
    - `ResolveResult`
    - `RouteState`
    - `SerializedSlot`
    - `SurfaceChrome`
    - `TypeMarker`
  - Exports (values):
    - `AppNavBoundary`
    - `appNavSink`
    - `clearRoute`
    - `createPaneStore`
    - `currentRoutePath`
    - `currentRoutePrefix`
    - `definePaneHeaderSlot`
    - `defineRoute`
    - `openPane`
    - `Pane`
    - `PaneBasePathContext`
    - `PaneBox`
    - `PaneChrome`
    - `PaneHeaderCell`
    - `PaneIconAction`
    - `PaneInstanceContext`
    - `PaneLayoutContext`
    - `PaneLoadScopeContext`
    - `PaneMatchContext`
    - `paneOwnerFor`
    - `PaneScroll`
    - `PaneStoreContext`
    - `PaneSurfaceAppContext`
    - `PaneSurfaceProvider`
    - `paneThemeScope`
    - `parseUrl`
    - `peekBasePath`
    - `peekRoute`
    - `reorderRoute`
    - `resolveFrom`
    - `resolveRow`
    - `restoreRoute`
    - `routeHomeApp`
    - `rowOrStale`
    - `setBasePath`
    - `setHistoryAdapter`
    - `setLiveStore`
    - `stripBasePath`
    - `SurfaceChromeContext`
    - `type`
    - `useAppNavBoundary`
    - `useCurrentPane`
    - `useIndexMatch`
    - `useOpenPane`
    - `usePaneMatch`
    - `usePaneStore`
    - `usePaneTitle`
    - `usePaneViewParam`
    - `usePathname`
    - `useRenderSync`
    - `useReservesFloatingBar`
    - `useRoute`
    - `useRouteState`
    - `useSurfaceAppId`
    - `useSyncPaneRegistry`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --pane-title-foreground`
    - `ui/tokens/color-palette --toolbar-foreground`
    - `ui/tokens/density --chrome-pad-x`
    - `ui/tokens/density --chrome-pane-card-h`
    - `ui/tokens/density --chrome-pane-card-pad-end`
    - `ui/tokens/density --chrome-pane-card-pad-start`
    - `ui/tokens/density --chrome-pane-pad-end`
    - `ui/tokens/density --content-inset`
    - `ui/tokens/density --space-2xs`
    - `ui/tokens/density --space-md`
    - `ui/tokens/shape --spacing`
  - Imported by: 186 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×68
    - `conversations` ×30
    - `debug` ×27
    - `active-data` ×10
    - `tasks` ×9
    - `apps-core` ×6
    - `plugin-meta` ×6
    - `layouts` ×4
    - `primitives` ×4
    - `infra` ×2
    - `reports` ×2
    - `stats` ×2
    - `ui` ×2
    - `audience/settings`
    - `auth`
    - `backup`
    - `build`
    - `code-explorer/commit-detail`
    - `config_v2/settings`
    - `hints/ask`
    - `integrations/google-maps`
    - `menu-bar`
    - `page/prototype`
    - `review`
    - `runs`
    - `screenshot`
    - `shell/notifications`
- Exemptions:
  - Exempts itself from: `pane/no-core-define-route-in-web` — `.` (sanctioned)
  - Exempted by:
    - `primitives/bar` (0 debt)
    - `primitives/pane` (0 debt)
- Core:
  - Exports (types):
    - `AppColorMode`
    - `AppRef`
    - `PositionalRouteParams`
    - `RouteDef`
    - `RouteParams`
  - Exports (values):
    - `APP_COLOR_MODES`
    - `defineApp`
    - `defineRoute`
    - `fillSegment`
    - `indexKeyedSuffix`
    - `MissingRouteParamError`
    - `normalizeRoutePath`
    - `onlySurfaceViews`
    - `parseSegmentParts`
    - `readIndexKeyedParams`
    - `readKeyedParams`
    - `segmentKeyedParamNames`
    - `segmentMatchPatterns`
    - `segmentParamNames`
    - `segmentRequiredParamNames`
    - `splitKeyedPart`
    - `splitSurfaceViewPart`
    - `surfaceViewKey`
    - `surfaceViewsOf`
    - `withoutSurfaceViews`
- Test helpers:
  - Web: `@plugins/primitives/plugins/pane/web/testing`
    - `createTestSurfaceStore` — A surface store, bound as the live store so the imperative free functions and the module-level history listener agree with it.
    - `defaultStore`
    - `TestSurface` — A pane surface: `PluginProvider` + the real `PaneSurfaceProvider`.
- Sub-plugins:
  - **`route-prefix`** — Route prefixes: a leading address-bar segment owned by a surface mode rather than an app (the desktop's /desktop, written before the focused window's URL). The known prefixes every read strips…

<!-- AUTOGENERATED:END -->

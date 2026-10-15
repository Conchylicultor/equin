# Pane

The unified pane primitive. One pane = one URL segment + one component. The
runtime source of truth is the **route store** (`currentRoute: PaneSlot[]`), not
the URL: the URL is derived for deep linking, and the route is persisted in
`history.state` so back/forward works without re-parsing. The route is
layout-agnostic — a layout renderer maps it to an arrangement (Miller paints
each pane as a column; Full-pane paints only the current pane). Each pane is
self-contained: it receives `options` / an optimistic `hint` from its opener and
self-fetches any data it needs.

Design rationale lives in:

- `research/2026-04-23-global-unified-pane-manager-v2.md` — core design.
- `research/2026-04-23-global-unified-pane-manager-v3.md` — refinements
  (`.open()` — since replaced by the free `openPane` — takes full params;
  `useParams()` is own-only; prefix matching).
- `research/2026-04-30-plugins-miller-columns.md` — layout renderer.
- `research/2026-05-15-global-remove-after-pane-state.md` — route-first
  architecture, `after:` removal, `input`/`useInput()` (since split into
  `options`/`hint` — see below), `defaultAncestors` (since replaced by the
  route's `parent` chain).
- `research/2026-07-10-global-pane-input-hint-vs-options.md` — why `input`
  became `options` + `hint`, and why a hint cannot be a write source.

## Define a pane

A pane's **identity** is a `RouteDef` — its id, its own URL segment, and its
place in a chain of parents. `defineRoute` states it once, and `Pane.define`
attaches behavior to it:

```ts
// web/panes.tsx — each route sits immediately above the pane it names
const tasksRootRoute = defineRoute({ id: "tasks-root", segment: "tasks" });

const taskDetailRoute = defineRoute({
  id: "task-detail",
  segment: "t/:taskId",
  parent: tasksRootRoute,   // prepended when opening from scratch, and part of the URL
});

export const tasksRootPane = Pane.define({
  route: tasksRootRoute,
  app: agentManagerApp,   // mandatory — see "A pane's home app" below
  component: TasksRoot,
});

export const taskDetailPane = Pane.define({
  route: taskDetailRoute,
  app: agentManagerApp,
  component: TaskDetail,
  useResolve: useResolveTask,   // required: the route has a `:param`
});
```

Same file is the default. Promote a route to the plugin's `core/` only when
something outside `web/` must build the link — a server-side notification's
`linkTo`, or another plugin naming it as a `parent`, which is why these two
really live in `tasks/plugins/tasks-core/core/routes.ts`. Promoting one route to
`core/` forces every ancestor route there too, so do it deliberately rather than
by habit. Never write `export const xRoute = defineRoute({…})` in an
`index.ts`: a barrel takes no `export const`.

`Pane.define` is a pure factory: it returns a typed `PaneObject`
(`.useParams()`, `.link()`, `.useToggle()`, `.Actions`) but does NOT make the URL
routable. Register every pane your plugin owns with a `Pane.Register({ pane })`
entry in the plugin's `contributions` array — a defined-but-unregistered pane
compiles fine and never matches.

Rules:

- `parent` is what makes the ancestor's segment part of this pane's URL, and
  what types this pane's params as the **chained** set (`{ taskId }` plus
  whatever the parents declare). It is also the pane's from-scratch ancestry —
  a hint for opening with no caller context, which does NOT constrain where the
  pane can appear. Any pane can appear at any position in the route.
- **A pane with no ancestor gets a parentless route.** Inventing a parent
  because it reads better adds a segment to every from-scratch URL and an extra
  Miller column.
- `segment` is the route's own URL fragment (no leading slash); supports
  `:param`, `:rest*` and an optional `:param?`. Use `""` for "no URL segment of
  my own". A bare leading `:param` throws at define time (add a static prefix,
  e.g. `t/:taskId`); global uniqueness is enforced by the `pane:segments-unique`
  check.
- An optional `:param?` must be the segment's **last** part (`defineRoute`
  throws otherwise). It is for a VIEW of the entity the pane shows — which tab,
  which stage — so that view has an address while the bare URL stays valid
  (`proto/:name/:stage?`: `proto/x` and `proto/x/compare`). It types as an
  optional key, is written only when supplied, and claims both URL shapes for
  collisions. The parser takes the longer match and falls back to the shorter
  when the rest of the URL then parses to nothing — but a URL whose next part
  belongs to a pane that has not loaded yet reads as the optional value. Change
  it from inside the pane with `pane.useSetParams()` (below), not a `swap`.
- A **keyed** param `;name` — after the positional parts, any number of them:
  `song/:songId/:bar?;view;zoom` — is the unbounded form of the same idea, for
  when a pane has more than one view of its entity, or one beside an optional
  `:param?`. Each is an optional key, written as a matrix parameter on the
  pane's LAST URL part (`/song/abc/12;view=notation`), in declaration order,
  only when supplied. Matrix rather than `?query`: in a multi-pane URL each part
  belongs to one pane, so the key is scoped to the pane declaring it (a query
  string is one bag every column would compete for), and it stays in the
  pathname every routing consumer already carries. An undeclared key in the
  address bar is dropped (the pane shows its default view, never a dead link);
  a pane declaring no keyed params reads a raw `;` as text, as it always did.
  Keyed params do not change a segment's collision shape and do not count
  toward "paramful" (`useResolve`): they view an entity, never address one.
- `useResolve` is required exactly when the route's own segment has a `:param`, and
  forbidden when it does not — a paramful pane must be able to say "no such
  entity". Opt out with `useResolve: false`. The key is `use`-named because its
  value is a hook (a `Hook<…>`-branded field, see `primitives/hook-value`): the
  guard calls it as `useResolve(params)`, so the React Compiler treats the call
  as a hook and never memoizes it. The hook returns a `ResolveResult`:
  `pending` / `error` (with an optional `retry`) / `missing` / `found` — the
  vocabulary by-id domain reads (`useRun`, `useReport`) already speak, so those
  are returned as is. Over a live read use `resolveFrom(result, isFound)`, over
  a `useLiveRow` `resolveRow(row)`. The guard paints Loading, the failure with
  Retry (`ResourceErrorInline`), or Not Found; once `found` it stays mounted
  through later `pending` / `error` flips (sticky), and only `missing` unmounts
  it. Never answer `found` or `pending` for a failed read — `error` exists for
  exactly that.
- `width` (optional) — default column width in pixels for column layouts
  (Miller). Last column flex-grows regardless. Defaults to 400.
- `options` / `hint` — see **Non-URL state** below.

## Read params

`pane.useParams()` is **own-only**: it returns only the `:name` segments from
*this* pane's `segment`, not any inherited from ancestors. Reading an ancestor's
params is explicit: `ancestorPane.useParams()`.

## Query the route from outside a pane

The route match is a property of the **surface**, not of the layout renderer
that paints the main area. `PaneSurfaceProvider` resolves it once for the whole
surface subtree, so a sidebar, a pane toolbar and a pane body all read the same
match.

Use `pane.useRouteEntry()` (first match, or `null`) / `pane.useRouteEntries()`
(for panes that can appear more than once, e.g. `conversationPane`) to check
presence and read params — without reaching into `_internal` or importing
`usePaneMatch()`. Each entry is `{ instanceId, params, fullParams }`; pass
`instanceId` to `pane.close(instanceId)` to close the specific instance found.

`pane.useOpenedHere()` answers the narrower question a surface that opens things
actually asks: **which instance did *I* open?** — the first entry for this pane
sitting after the caller's own pane in the chain. `useRouteEntries()` cannot
answer it, and the two heuristics that grew up in its place were each wrong in
their own direction: "the last entry, but only if there are two" goes blind
whenever the calling surface's pane was not itself opened from one, and "the last
entry" walks off to a grandchild as soon as the column you opened opens another
beside it. Reach for `useRouteEntries()` only when the question really is about
the whole chain (the sidebar's "which conversation is the user reading" wants the
deepest column, not the one below it).

**Outside every surface there is no route to READ.** Global chrome (the action
bar at `Core.Root`, `Apps.TabBarActions`, and every popover hanging off it) is
not inside any `PaneSurfaceProvider`, so these hooks throw there rather than
returning a plausible-looking `null` — the same policy as `usePaneStore()`.
`null` stays a legitimate *in-surface* answer ("this pane is not in the route").
To react to the focused tab's route from global chrome, use `useTabs()` /
`navigate()` from `@plugins/apps-core/plugins/tabs/web`.

**Opening one from there is fine, though** — see `useOpenPane` below. Reading
and navigating are not the same requirement, and conflating them was a trap: a
control reusable enough to appear both inside a pane and in a popover (a config
gear, an active-data chip) is not written twice, so it crashed on arrival in the
popover.

**`useOpenedHere()` is the one read that is legal there too**, returning `null`.
It is the read half of opening (an opener's "is this the one I opened?"), so it
must go wherever `useOpenPane` goes or every opener widget crashes in the
popover again. `null` is true there, not a stand-in: a caller with no route
opens into the focused tab with no position, so nothing it opened is "here" —
its toggle always opens and never closes a column in a tab it cannot see.

## Non-URL state: `options` and `hint`

A pane can receive state at creation time that doesn't belong in the URL.
There are exactly **two kinds**, and which one you have is decided by a
single question: **does this value have a canonical server-side owner?**

|  | `options` | `hint` |
|---|---|---|
| Canonical owner | none — the pane owns it | a live-state resource owns it |
| Absence means | the declared default | wait for canonical |
| Persisted | yes (`history.state`, tabs, pane-restore) | **never** |
| Read as | `useOptions()` → **total** `Options` | `useHint()` → `Hint<T>` |
| Safe to write back | it's UI config; nothing writes it | **never** |

There is no third kind. If a value is already in the URL — including an
ancestor pane's params — read it from the route (`ancestorPane.useRouteEntry()`),
not from either of these.

### `options` — opener-supplied UI configuration

Declare the **defaults**, not a type. The default *is* the deep-link value,
stated once:

```ts
Pane.define({ route: fileRoute, app, component: FileBody, options: { compact: false }, useResolve: useResolveFile });
openPane(filePane, { path }, { mode: "push", options: { compact: true } });  // partial override
```

`filePane.useOptions()` is **TOTAL**, never `Partial` — nothing to `??` at a
read site. A pane that declares no `options` **rejects** them at the call site.

### `hint` — an optimistic mirror, structurally unwritable

A hint pre-paints server-owned state before the canonical resource settles.
It is absent on every route the browser rebuilt (deep link, reload,
back/forward) and may be stale when present. **It is never a source of truth.**

```ts
Pane.define({ …, hint: type<{ title: string }>(), title: { useText: useSongTitle } });

openPane(sonataPlayerPane, { songId }, { mode: "root", hint: { title: song.title } });

function useSongTitle({ songId }: { songId: string }, hint: Hint<{ title: string }>) {
  const library = useLive(songs);
  const canonical =
    library.status === "ready" ? library.data.find((s) => s.id === songId)?.title : undefined;
  return hint.pick("title", canonical);   // canonical wins; hint fills the gap
}
```

`Hint` holds **no data**. `pick(key, canonical)` is the only accessor and it
*requires* the canonical value — so you cannot read a hint apart from its
source of truth, and if you already hold the truth you have no reason to write
the hint. The hint is also never serialized, so it cannot outlive the
navigation that created it.

`pick` returns `T[K] | undefined`. Defaulting that to a fabricated value is
banned by `lint/no-hint-fabrication`:

```ts
hint.pick("title", canonical) ?? "Untitled"                    // ✗ fabrication
hint.pick("title", undefined)                                  // ✗ recovers the bare hint
hint.pick("title", canonical) ?? null                          // ✓ honest absence
hint.pick("title", canonical) ?? <Placeholder>Untitled</…>     // ✓ a ReactNode is never a DB value
```

> **Why this shape.** The old `useInput()` made a possibly-absent display hint
> look like ordinary pane data: a deep-linked song seeded an app-context mirror
> with `input.title ?? "Untitled"` and a chord-grid autosave wrote `"Untitled"`
> over the real name. See
> `research/2026-07-10-global-pane-input-hint-vs-options.md` and
> `research/2026-07-10-sonata-song-title-single-owner.md`.
>
> The lint rule cannot decide the *declaration*: if an option's default would be
> a **lie about server state** (`options: { title: "Untitled" }`), it is a hint,
> not an option.

## Navigate

There is no `pane.open()`. Opening is a free function, `openPane(pane, params,
opts)`, and it comes in two forms:

- **`openPane` (module-level, `pane/web`)** — the imperative, non-hook open. It
  targets the live store rather than any particular surface, and its type
  accepts **only** `{ mode: "root" }`: with no caller position there is nothing
  to be relative to, so the one honest thing it can do is start a fresh route.
- **`useOpenPane()`** — the caller-aware hook, below. Same call shape, all three
  modes.

Both take the **full ancestor + own** param set, because that is what a URL
needs. `pane.link(app, params)` builds that URL without navigating (it delegates
to the route, which knows the parent chain); `pane.useToggle(params, opts)` is
the open-or-close pair for a button that shows and hides one pane.

The rest of `PaneObject` is unchanged: `close(instanceId)` navigates to the
parent, `unwrap(instanceId)` removes this pane and keeps its children,
`promote(instanceId)` detaches from ancestors and makes this pane the root, and
`back()`/`forward()` walk browser history. `useClose()` / `usePromote()` are the
bound-to-this-instance hook forms.

`useSetParams()` rewrites THIS instance's own params in place: the URL changes
(with a history entry per `chrome.history`), the instance does not — no remount,
and the column keeps its collapse / maximize state, options and the panes to its
right. Use it for an optional `:param?` or keyed `;name` view switch. It replaces
the instance's whole own param set, so pass the ones you keep. Showing a different entity
is a `swap`, which mints a fresh instance so nothing of the old one leaks.

### `useOpenPane` — caller-aware navigation

Inside a pane component, `useOpenPane()` returns an
`openPane(pane, params, opts)` that knows the caller's position in the route.

**A control that opens a pane spreads its link form**, `openPane.link(pane,
params, opts)` — the same arguments — instead of calling it from `onClick`:

```tsx
<Button {...openPane.link(traceDetailPane, { id }, { mode: "push" })}>Open trace</Button>
onSelect={(id) => openPane(reportDetailPane, { reportId: id }, { mode: "push" })}  // no control: the call
```

Plain click opens exactly as the call does; ⌘/Ctrl- and middle-click open the
URL of the route that plain click *would* produce in a new **browser** tab
(`primitives/link-gesture`'s `linkProps`) and leave this tab alone. The URL is
computed at click time, against the route then on screen; when the target is
already shown it is the current route's. Both halves run one pure
`computeOpen(currentRoute, callerInstanceId, target, params, opts)` — the only
place the modes below are implemented, shared with `store.openPaneImpl` and
`promote` — so the URL a link hands the browser cannot drift from what its click
does. `store.routeUrl(route)` is the base-path-prefixed address for a route.
`hint` is lost in the new tab (it always is on a rebuilt route), and `options`
are not in URLs: state a link must carry belongs in a URL param.
`link-gesture/no-click-navigate` flags any click-style callback (`onClick`,
`onRowActivate`, `onOpen`, …) or plain-function activation whose only job is
`openPane(…)` (or another navigation) — pass `openPane.link(…)` / `openPane.to(…)`
instead.

Modes:

- `"root"` — replace the entire route with a fresh one rooted at target.
- `"push"` — insert target relative to the caller. `side: "right"`
  (default) appends after the caller, truncating siblings to the right.
  `side: "left"` inserts before the caller — **unless the target is already an
  ancestor**, in which case it is not skipped: control falls through to the
  right-push, so the pane is appended *after* the caller instead. A left-push at
  a pane that is already to your left therefore duplicates it on your right.
- `"swap"` — replace the caller's slot in-place (same pane type,
  different params), truncating children.
- `"append"` — put target after the route's LAST pane, whoever the caller is,
  and replace that last pane instead when it is the same pane type (so a
  preview opened again swaps its column rather than stacking). The positional
  open for global chrome — a popover in the action bar has no caller, so its
  `push` would rebuild the route instead of opening beside it.

**It is legal everywhere**, unlike the route reads above. Opening a pane is an
imperative op — the hook returns a callback and reads nothing during render — so
it takes the surface's store when there is one and the **focused tab's** store
otherwise, resolved when the click happens rather than when the component
rendered (global chrome outlives the tab it was rendered beside).

With no caller pane in the route there is nothing to be relative to, so a
`push` / `swap` falls back to the same non-positional open the module-level
`openPane` performs — but **not** to `mode: "root"`, and the difference shows
whenever the target is already somewhere in the route:

- `"root"` always discards the route and rebuilds it from the target's parent
  chain, exactly like clicking the entry in a sidebar.
- a caller-less `"push"` / `"swap"` first looks for the target in the current
  route. Same params and options ⇒ nothing happens; otherwise the existing slot
  is replaced in place and everything after it is truncated. Only when the
  target is absent is the route rebuilt from its parent chain.

## Chrome

**Every pane wraps its body in `<PaneChrome pane={…}>`** — there is no opt-out:
`PaneChrome` ALWAYS renders a header `Bar` plus exactly one body scroll
(`PaneScroll`), so a pane can never strand its own scrolling. The header is one
overflow-collapsing bar rendering the pane's ONE header slot (`pane.Actions`),
then promote and × close — which only show when `depth > 0`.

There is no second kind of header. A pane that needs a **rich** one (transport /
view-switcher / volume) is the ordinary case with more items in it: the title is
a contribution of the same slot, so a rich header collapses into the `⋯` like
any other, and what separates a leading group from a trailing one is a `spacer`
node in the slot's reorder config rather than a field on the contribution.

### The title (`Pane.define({ title })`)

A pane's title is declared ONCE, on its definition, and is the single source for
the tab label, the browser document title and the header's title item.
`PaneChrome` takes no title — and no header content of any kind.

```tsx
Pane.define({ …, title: "Settings" });            // shorthand for { useText: "Settings" }
Pane.define({
  …,
  title: {
    useText: usePageTitle,       // string | (params, hint, options) => string | undefined
    fallback: (p) => p.pageId,   // string | (params) => string — while `useText` yields undefined
    component: PageTitleTrail,   // optional rich HEADER title (breadcrumb, editable field)
  },
});
<PaneChrome pane={pageDetailPane}>…</PaneChrome>    // no title prop
```

- **`useText`** is a literal or a React hook (a `Hook<…>`-branded field). The hook runs **outside** the owning
  app's providers — at the tab surface, for background tabs too — so it may
  read only its arguments (the CHAINED params, ancestors included; the `hint`
  and `options` as values) and GLOBAL hooks (live-state resources), never
  app-local context. Return `undefined` while the entity is not known yet.
- **`fallback`** is what shows while `useText` yields `undefined`: the generic
  noun ("Task"), or something derived from the URL params. Never a fabricated
  entity name.
- **`component`** is a rich title for the HEADER only. It is mounted **inside**
  the pane (the header's title cell, under `PaneChrome`), so it may call
  `pane.useParams()`, read app context, and be interactive. Tab and document
  titles still come from `useText` / `fallback`, so declare `useText` beside it.

Resolution is one function, `usePaneTitle` (`useText` → `fallback` → nothing),
shared by the tab reporter, the collapsed Miller column and the header. The
header's title item paints `component` when declared, else that string, else
nothing (the yielding cell stays, empty).

#### No side door into the header row

The header row is ONE slot, `pane.Actions`; the title is one item of it. Every
other control in the row is another item of that slot, and which end of the
row it sits at is a `spacer` in the slot's order file. There is no prop to pass
header content through (`title` / `extra` / `headerSpill` are gone — each was a
door a second slot was smuggled through), and a `title.component` may not
render a slot either: the pane registers a slot-item middleware that **throws**
when a render-slot contribution mounts inside the title cell ("A render slot
mounted inside the pane title…"). The throw lands in the offending item's error
boundary. Plain and dispatch slots painted once inside a title (a breadcrumb's
separator) are part of the title and are not caught.

#### Tab / document title ownership (`titleOwner`)

The pane's own header title (above) is distinct from the **tab/document title**.
That one is resolved per route by the tab surface via `usePaneTitle` against
the route's **title owner**: the FIRST pane in the route declaring
`titleOwner: true`.

`titleOwner` marks a **main surface** — a pane whose entity is the identity of
the page (a conversation, a task, a page, a song), as opposed to navigation
lists/trees or auxiliary tool panes (file peek, review, terminal).
First-owner-wins gives the right answer in both directions from one static
declaration: aux panes stacked to the right never steal the title, and the same
conversation pane opened as a drill-in under a task stays subordinate to it.
Routes with no title owner fall back to the leaf pane (then the app index pane,
then the app name).

Declaring `titleOwner` without a `title` that actually resolves (`useText` or
`fallback`) would pin the tab to the app name — give the owner a title source.

#### Title typography is container-owned

The title item wraps the title — string **or** `component` — in the canonical
`<Text variant="label">` baseline (see `pane-title.tsx`). A title component
therefore inherits the pane-title size and **must not set its own typography
size** — per-segment weight/color (e.g. a breadcrumb's `font-medium`/muted)
still composes on top, but the *size* comes from the container.

Enforced by `lint/no-adhoc-pane-title`; raw `text-*`/`leading-*` is already
banned everywhere by `text/no-adhoc-typography`.

### `PaneScroll` — the sanctioned pane-body scroll viewport

`PaneScroll` is the single sanctioned pane-body vertical scroll viewport — a
dead-thin `<Scroll axis="y" fill h-full>`. The mental model is: **a pane body is
exactly one `PaneScroll`; every header inside it is a `<Sticky>`** (from
`@plugins/primitives/plugins/css/plugins/sticky/web`), so toolbars and section
headers pin against this one viewport instead of each owning a nested scroller.

`PaneChrome` always routes its body through `PaneScroll`, so pane bodies get the
one sanctioned scroll for free and **should not add `overflow-*` on their root**:

- **Simple content** → do nothing. PaneChrome scrolls.
- **Header + scrollable body** → root is `flex h-full flex-col`; the inner
  scrollable region is a `<PaneScroll>` (not a re-derived
  `overflow-y-auto min-h-0 flex-1`). PaneChrome's scroll is naturally inert
  (`h-full` fills it exactly).
- **Custom viewport** (terminal, canvas) → root is `h-full`;
  `overflow-hidden` on root is acceptable as a defensive measure.

`PaneScroll` forwards `ref` (for a host that needs the scroll-container element,
e.g. an `IntersectionObserver` root) and the rest of `Scroll`'s surface
(`hideScrollbar`, `isolate`, `as`, `className`).

### `overlay` — widgets that float over the body

Chrome that must NOT scroll with the document (an outline rail, a progress card)
goes in `<PaneChrome overlay={…}>`, which renders it as a sibling of the single
`PaneScroll` inside a `relative isolate` host. Do **not** wrap `PaneChrome` in
your own `relative` host instead: that host spans the header too, so a
corner-pinned overlay lands on the header's own right-hand actions.

### `floatingHeader` — a page that runs up behind its header

`<PaneChrome floatingHeader>` moves the header bar from above the scroll to
inside it, as its first child, pinned to the top: see-through with no rule while
the body is at its top, masked with its rule once content scrolls under it.
Layout at rest is unchanged. Only for a page designed to show through the header
(the website's hero glow) — a header above the scroll can never show anything
behind it. An `overlay` then spans the header too.

`headerTheme` (a theme scope, `subThemeScope(…)`) is the theme the floating
header wears, for a page whose own picture runs under the header in another
palette than the page (the website's iceberg: a white sky, then black water).
The page may change it as it scrolls; the bar masks with that theme's own
background, which the pane republishes as `--chrome-mask` on the bar.
`headerGlass` frosts the mask (`<Sticky mask="glass">`: the background at 72%,
what scrolls under it blurred) instead of painting it opaque.

### The header slot (`Actions`)

Each pane auto-creates an `Actions` slot other plugins contribute to
(`taskDetailPane.Actions({ id, component })`). It is the WHOLE header row, title
included — one `defineRenderSlot<PaneHeaderItem>`, one reorder directive, one
`⋯`.

A `PaneHeaderItem` carries exactly one renderable form — a `component`, or an
`onClick` with a `label`/`icon` — so an item that would render nothing is
unconstructable. There is no `position`: order, hiding and grouping are the
slot's reorder config, like every other render slot. Author a leading/trailing
split with a `{"type":"spacer"}` node between the two groups; with no spacer the
occupants pack against the trailing edge, which is what a pane header wants.

**`id` is required and must be stable for the contribution's whole life** —
short kebab-case naming the action (`"improve"`, `"view-mode"`). It keys the
[`AdaptiveBar`](../adaptive-bar/CLAUDE.md) width ledger and DOM move plan below,
so an id that churns per render throws every measurement away each frame.

For the common ghost-icon-button case, use the shared `<PaneIconAction label
icon onClick>`; it forwards refs so it composes with components that need a
button ref. (Base UI Popover triggers don't take `asChild` — use
`<PopoverTrigger className={buttonVariants({variant:"ghost",size:"icon"})}>`
directly when the trigger needs to be a popover.)

#### The title is a contribution

`pane` itself contributes one `title` item into every header
(`primitives.pane:title`), so **nobody re-contributes a title**: authoring is
`Pane.define({ title })` (above). `PaneChrome` publishes the pane and its match
entry on a context; the item resolves the title from them and renders `null`
when there is none. The item is minted per declared header slot on each
slot-declaration pass (`web/header-slot.ts`) — a slot is only NAMED by that
pass, and `Pane.define` runs at each pane plugin's module scope, so there is no
earlier moment at which the set of headers is knowable. A borrowed header
(`Pane.define({ actions })`) has one title item, which paints the title of
whichever pane's `PaneChrome` renders it.

It renders in the bar's **yielding cell** (`cell: "yield"`): excluded from the
fit ledger, `min-w-0` so it ellipsizes instead of pushing the actions out of the
row, and holding the row's leftover so the occupants stay packed right. `cell`
is a public, generic field — at most one per header, and the bar throws on a
second — so a plugin can put something else there; the title is not a special
case.

The tab/document title reads the same declaration through `usePaneTitle`, never
the slot — hiding the title item in the order file leaves the tab title alone.

#### When the header runs out of room

The header items are the `AdaptiveBar` occupants of the row: each is asked for a
smaller form of itself, and whatever still does not fit is **moved** — the same
live element, never a second copy — into a panel behind a `⋯`. The yielding
cell (the title) is never measured, demoted or relocated.

There is no per-instance side door into the row (see **No side door into the
header row** above): `PaneChrome` once took `extra` and `title` nodes, and a
whole second slot got smuggled through each — the Pages app's `HeaderActions`
and the conversation's `Header` — so nothing could be placed beside the title.

The bar's own limits apply to what you contribute — no `position: sticky` inside
an item, and an item holding an `<iframe>` refuses to relocate.

`<PaneChrome titleOnly>` renders the yielding cell and suppresses every ordinary
occupant, for a host that paints its own actions inside its content area
instead.

### Hiding the close / promote buttons

- `chrome: { close: false }` — when close has no meaningful destination (the
  pane navigates elsewhere on close, or its parent isn't a "back" target).
- `chrome: { promote: false }` — for compact side-panels with their own expand
  action (e.g. a button that opens the full detail pane as root).

### A header shared by several panes (`Pane.define({ actions })`)

Several panes can wear ONE header — the website's five pages share one nav — by
borrowing the slot instead of each minting its own:

```ts
// once, in the plugin that OWNS the header:
export const WebsiteHeader = definePaneHeaderSlot();          // pane/web
// …and declare it there, exactly once, under a key of its own:
slots: { ...Website, header: WebsiteHeader }

// other plugins contribute to it like any slot:
WebsiteHeader({ id: "download", component: DownloadNavItem });

// every borrowing pane names it; `pane.Actions` then IS that slot:
export const downloadsPane = Pane.define({ …, actions: WebsiteHeader });
```

One slot, one contribution list, one config directive
(`config/apps/website/shell/header.jsonc`). NO borrowing pane is listed in a
`slots:` record — not even the owner's own pane, whose `Actions` is this same
object: the shared slot is declared once, under the `header` key, and reaching
it a second time through a pane is what the declaration pass rejects ("one slot
is declared under two keys").

`definePaneHeaderSlot()` owns the `docLabel` and the optional `controlSize`
override for the header (the pane `Bar` already supplies the `sm` baseline).
`Pane.define` mints through the same factory, so a borrowed header and an
auto-minted one are the same kind of slot.

Hand-rolling a `border-b` header bar inside a pane body is banned by the
`no-adhoc-pane-toolbar` lint rule — contribute to the pane's header instead.

## Router

The **route store** is the single source of truth at runtime. Navigation
APIs (`openPane`, `useOpenPane()`, `restoreRoute`) mutate the route
directly. Each mutation:

1. Updates `currentRoute` (the in-memory `PaneSlot[]`).
2. Derives the URL via `buildRouteUrl()`.
3. Emits a push/replace **intent** — `{ url, state, mode }` — through the
   installed **`HistoryAdapter`** (`history-sink.ts`). The pane store never
   touches `window.history` itself. `state` is the serialized route (paneId,
   params, options per slot — never the `hint`, which is in-memory only) or
   `{ pending }` for an unresolved URL.

### The `HistoryAdapter` seam

The browser URL + `history.state` are a pure **projection** of the store, and
the store writes that projection only through an adapter, so the pane primitive
stays app-agnostic:

- **`commit(change)`** writes the URL + history entry and announces
  `shell:navigate` (never a synthetic `popstate`).
- **`restore()`** runs on a REAL browser back/forward — the single module-level
  `popstate` listener is its only caller — and rebuilds the in-memory state.

Programmatic navigation ⇒ `shell:navigate`; browser traversal ⇒ `popstate`. A
hard event contract, not idempotency-by-comparison. The adapter lives in an
[`install-sink`](../scope/plugins/install-sink/CLAUDE.md) filled with the
**`defaultHistoryAdapter`** (standalone / tests), which writes the route
verbatim and restores it straight back into the live store via
`handleLocationChange()` — so the slot is never empty and teardown never has to
remember the default (`setHistoryAdapter` returns the disposer that restores
it). The **tabs layer installs an app-aware adapter** that widens
every entry into a complete SNAPSHOT of what the user was looking at —
`{ tabId, appId, appInstance, route | pending }` — and restores it whole
(refocus the tab, re-sync its app, restore the route) with zero URL parsing. See
the tabs `CLAUDE.md` for the snapshot model.

`appInstance` (from `primitives/scope/app-instance`) names one running SPA app-state,
of which a single browser tab hosts a sequence — so an entry says not just which
tab it belonged to but which instance that tab id is meaningful in, letting a
cold boot tell "restore the state this entry belongs to" from "this entry came
from somewhere else". None of it reaches the primitive:
`handleLocationChange` reads only `route`/`pending` and ignores the extra keys,
so the pane store never learns about tabs.

URL parsing (`parseUrl`) is only a fallback for initial page load, shared deep
links, and legacy history entries with no snapshot.

### The address bar is untrusted input

Every read of the browser's route path goes through **`currentRoutePath()`**
(`pane/web`), which canonicalizes `window.location.pathname` via
`normalizeRoutePath()` (`pane/core`): repeated `/` runs collapsed, exactly one
leading `/`. A raw pathname fails twice, in ways that look unrelated:

- **As a history URL** it is *scheme-relative*. `replaceState(s, "",
  "//agents/c/x")` resolves against the document to `http://agents/c/x` — a
  different origin — and throws `SecurityError`. That is a hard boot crash on a
  deep link with a doubled slash.
- **As a match key** it silently misses: `"//agents/c/x".startsWith("/agents/")`
  is false, so the URL owns no app and the deep link falls back to the default
  app.

Because the canonical path is also what the boot replace-stamp commits, a
slash-mangled deep link **self-heals** — the address bar is rewritten in place
to the working URL. `pane/no-raw-location-path` keeps `currentRoutePath()` the
only reader (tests and `e2e/` are exempt; the reader itself and web-core's
pre-boot prefix match carry per-site disables).

The shell mounts a layout renderer once (`<MillerColumns/>` from
`@plugins/layouts/plugins/miller/web`, or `<FullPane/>`), which reads the route
via `useRoute()`. The router rebuilds its lookup table from the `Pane.Register`
contribution list synchronously on every render via `useSyncPaneRegistry()`.

## Testing

The jsdom suites live in `web/__tests__/` and run via `bun run test:dom
plugins/primitives/plugins/pane` (manual — nothing runs them automatically).

**Mount a pane surface with `TestSurface` from the pane testing barrel
(`@plugins/primitives/plugins/pane/web/testing`, `../testing` inside this plugin); never
hand-pick the contexts your component happens to need.** The fixture wraps the
real `PaneSurfaceProvider`, so a context that moves into the surface reaches
every suite at once:

```tsx
import { createTestSurfaceStore, TestSurface } from "@plugins/primitives/plugins/pane/web/testing";

const store = createTestSurfaceStore();   // in beforeEach
render(<TestSurface store={store} plugins={[testPlugin]}><ComponentUnderTest /></TestSurface>);
```

Two rules the fixture encodes, both of which have bitten:

- **A store is not optional.** `PaneStoreContext` has no default (see
  `usePaneStore`), so anything reaching a route hook — including a pane's
  Loading / Not-Found chrome, via `useClose()`/`usePromote()` — throws without a
  surface above it.
- **`live: true` for anything URL-derived.** `handleLocationChange` early-returns
  for a background store, so a `live: false` store never reads
  `window.location` and every deep-link case resolves empty. Conversely, pass
  `createTestSurfaceStore({ live: false })` when the suite restores a route by
  hand and must not have it re-parsed away from the URL.

Suites that only drive a `PaneStore` object (`pane-isolation`, `history-sink`)
need no surface at all — the fixture adds nothing there.

## A pane's home app, and what Expand means

`Pane.define({ app })` names the app a pane **belongs to** — not wherever it is
being rendered. Panes are reusable chrome: the agent manager hosts the page
detail beside a conversation, and Pages could host a conversation the same way.

Expand (the `navIcons.expand` button in `PaneChrome`, `usePromote()`) reads it and
picks one of two destinations:

- **hosted by another app** → hand the pane's app-rooted URL to the tab manager,
  so it lands in its own app with that app's whole surface around it. Offered
  even at route position 0 — `/agents/page/X` is a page stranded in the agent
  manager, which is precisely the case worth fixing. The button says where it
  is about to send you: **"Open in Pages"**.
- **hosted by its own app** → the original behavior: drop the ancestors and
  re-root the route here. Only meaningful below the root. The button says
  **"Expand pane"**, because there is no other app to name.

So `usePromote()` returns the destination, not just a way to get there: a
discriminated `PromoteAction` (`{ kind: "cross-app"; app; open; href }` /
`{ kind: "re-root"; open; href }`) the chrome labels itself from. `null` still
means "nowhere to go" and paints no button. `open` / `href` are a link's two
halves, so the button spreads `linkProps(promote)`: ⌘/middle-click opens the
destination — the home-app URL, or the re-rooted route's — in a browser tab.

### A pane wears its home app's theme

The same declaration decides how the pane **looks**. `PaneBox` stamps
`data-theme-scope="app:<home app id>"` on the pane's box (and forwards it across
portals, so the pane's popovers and menus keep it), so a page pane opened beside
a conversation in the agent manager is painted with the Pages palette rather than
the host's. Collapsed miller columns wear it too, so collapsing a guest pane does
not snap its rail back to the host's colors.

Only the *tag* lives here; whether it changes anything is theme-engine's. An app
that has forked its theme emits a matching `[data-theme-scope="app:<id>"]` block
(one per registered app, mounted centrally at `Core.Root`) and the pane picks it
up. An app that has **not** forked emits no block, so its panes inherit `:root` —
which currently carries the focused app's theme, i.e. the host's. Guest panes of
unforked apps therefore still look like their host; see the `theme` skill.

Light/dark is a single global `<html>.dark` class (per-scope color mode is
deferred), so a scope switches tokens — palette, typography, radius — never the
color mode.

**`app` is mandatory, with no opt-out** — being displayable in any app is a fact
about hosting, not an absence of ownership. The case that looks like an
exception isn't: the theme customizer restyles whichever app you are in, and its
home is still `settingsApp`, because Appearance is a Settings surface.

Write it right after the identity field (`route:`), importing the
`AppRef` from the app shell's **core** barrel
(`@plugins/apps/plugins/<app>/plugins/shell/core` — a leaf holding only
`defineApp({...})`, so it can never close an import cycle). Test fixtures
`defineApp` a local app instead, keeping this primitive's suites free of any
dependency on `plugins/apps`.

`AppRef.name` ("Pages", "Agent manager") is the **single** authoring site for an
app's display name — the rail tooltip, a tab's fallback title and Expand all
read it, so none of them restates it.

Cross-app Expand additionally needs an installed navigator, and a URL it can
actually build: a pane whose ancestor is paramful, opened from a route that does
not carry that ancestor, has no link to hand over. Either one missing degrades
silently to the same-app branch.

**Why a sink for the navigation.** `apps-core/tabs` imports this primitive, so
this primitive cannot import it back. Tabs installs its `navigate` into
`appNavSink` (`app-nav-sink.ts`) at provider mount, exactly as it installs its
history adapter — the pane layer calls a cross-app destination without knowing
tabs exists.

Both are [`install-sink`](../scope/plugins/install-sink/CLAUDE.md) sinks, which decides how
you read them: `appNavSink.useInstalled()` from a render path (subscribed, so a
late install re-renders whoever asked early), `peek…` only from an event handler
or an effect.

### The app's index pane (`appIndex`)

One pane per app is its **landing pane** — what the app's bare root shows when
there is no route yet (`/mail`, `/pages`, `/agents`). It says so with a boolean:

```ts
const mailRootRoute = defineRoute({ id: "mail-root", segment: "" });

export const mailRootPane = Pane.define({
  route: mailRootRoute,
  app: mailApp,
  appIndex: true,     // ← bare `/mail` resolves here
  component: MailRoot,
});
```

A boolean, not a path: *which* app's root is `app.basePath`, which the pane
already carries. `appIndex` stays on the pane while the route carries `segment:
""` — an index pane is reached at the app's base path and has no URL of its own.
Registry sync throws on a segment-bearing index pane and on a second index for
one app.

There is **no global fallback**: an app with no index pane shows an empty main
area at its bare root, which is a legitimate choice (`home`, `studio`).
`useIndexMatch(basePath)` resolves it; the main-area renderer paints it only for
a genuinely empty route, and overlay hosts ignore it.

### Companion panes (`companion`)

A pane that accompanies what is on screen rather than being a destination —
an attached file's preview, opened from a prompt — declares `companion: true`.
When a companion is the route's HEAD, the surface's match (`usePaneRoute`)
keeps the app's index pane to its left. So a file chip clicked in the agent
manager's home composer (`/agents`, an empty route) opens the preview beside
the home instead of replacing it, and `/agents/attachment/<id>` reloads to the
same two columns. The URL is untouched: the index pane has none. While a
companion leads, the tab keeps the index pane's title, and `useClose()` is not
null: closing it empties the route, back to the index pane alone.

Deeper in a route a companion is an ordinary pane, and a pane opened FROM the
index (a conversation) still replaces it — the index stays the landing, never a
column the route carries.

## Not yet implemented (deferred)

- `keepalive` for heavy panes — switching slots remounts by default.
- Layout tree (drag-and-drop, tabs, overlays).

See "Open questions" in the design doc.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Unified pane primitive: Pane.define and chrome components.
- Load-bearing: yes
- Web:
  - Slots: `Pane.Register`
  - Slot contributors: 92 contributors — full list in [REFERENCE.md](./REFERENCE.md)
    - `Pane.Register` ×92
  - Contributes: 115 contributions — full list in [REFERENCE.md](./REFERENCE.md)
    - `WebsiteHeader` "title" → `PaneTitleItem`
    - `accountsPane.Actions` "title" → `PaneTitleItem`
    - `agentDetailPane.Actions` "title" → `PaneTitleItem`
    - `agentReportPane.Actions` "title" → `PaneTitleItem`
    - `agentSidePane.Actions` "title" → `PaneTitleItem`
    - `agentsRootPane.Actions` "title" → `PaneTitleItem`
    - `allConversationsPane.Actions` "title" → `PaneTitleItem`
    - `app-preview.actions` "title" → `PaneTitleItem`
    - `appleSetupPane.Actions` "title" → `PaneTitleItem`
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
    - `conv-terminal.actions` "title" → `PaneTitleItem`
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
    - `exhibits.actions` "title" → `PaneTitleItem`
    - `explorerPane.Actions` "title" → `PaneTitleItem`
    - `filePeekPane.Actions` "title" → `PaneTitleItem`
    - `filesAtPane.Actions` "title" → `PaneTitleItem`
    - `filesHomePane.Actions` "title" → `PaneTitleItem`
    - `google-maps-live-map-setup.actions` "title" → `PaneTitleItem`
    - `googleMapsSetupPane.Actions` "title" → `PaneTitleItem`
    - `googleSetupPane.Actions` "title" → `PaneTitleItem`
    - `graphCanvasPane.Actions` "title" → `PaneTitleItem`
    - `healthMonitorPane.Actions` "title" → `PaneTitleItem`
    - `heapSnapshotPane.Actions` "title" → `PaneTitleItem`
    - `liveStateEmitPane.Actions` "title" → `PaneTitleItem`
    - `liveStateHealthPane.Actions` "title" → `PaneTitleItem`
    - `logChannelPane.Actions` "title" → `PaneTitleItem`
    - `logsPane.Actions` "title" → `PaneTitleItem`
    - `mail-message.actions` "title" → `PaneTitleItem`
    - `mail-root.actions` "title" → `PaneTitleItem`
    - `mail-search.actions` "title" → `PaneTitleItem`
    - `mailThreadsPane.Actions` "title" → `PaneTitleItem`
    - `memoryPane.Actions` "title" → `PaneTitleItem`
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
    - `prototypes-present-canvas.actions` "title" → `PaneTitleItem`
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
  - Uses: 33 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×4
    - `primitives/live-state` ×3
    - `primitives/slot-render` ×3
    - `primitives/css/scroll` ×2
    - `primitives/link-gesture` ×2
    - `primitives/adaptive-bar.AdaptiveBar`
    - `primitives/bar.Bar`
    - `primitives/css/center.Center`
    - `primitives/css/column.Column`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/spacing.Stack`
    - `primitives/css/sticky.Sticky`
    - `primitives/css/text.Text`
    - `primitives/css/theme-boundary.Theme`
    - `primitives/dom/in-view.useInView`
    - `primitives/hover-reveal.hoverRevealGroup`
    - `primitives/icon-button.IconButton`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/loading.Loading`
    - `primitives/overlay/tooltip.WithTooltip`
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
    - `appNavSink`
    - `clearRoute`
    - `createPaneStore`
    - `currentRoutePath`
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
    - `rowOrStale`
    - `setBasePath`
    - `setHistoryAdapter`
    - `setLiveStore`
    - `stripBasePath`
    - `SurfaceChromeContext`
    - `type`
    - `useCurrentPane`
    - `useIndexMatch`
    - `useOpenPane`
    - `usePaneMatch`
    - `usePaneStore`
    - `usePaneTitle`
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
    - `ui/tokens/density --chrome-pane-pad-end`
    - `ui/tokens/shape --spacing`
  - Imported by: 170 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×60
    - `conversations` ×29
    - `debug` ×25
    - `active-data` ×10
    - `tasks` ×9
    - `plugin-meta` ×6
    - `apps-core` ×5
    - `auth` ×4
    - `layouts` ×4
    - `primitives` ×3
    - `infra` ×2
    - `stats` ×2
    - `backup`
    - `build`
    - `code-explorer/commit-detail`
    - `config_v2/settings`
    - `integrations/google-maps`
    - `reports`
    - `review`
    - `runs`
    - `screenshot`
    - `shell/notifications`
    - `ui/theme-engine/theme-customizer`
- Exemptions:
  - Exempts itself from: `pane/no-core-define-route-in-web` — `.` (sanctioned)
  - Exempted by:
    - `primitives/bar` (0 debt)
    - `primitives/pane` (0 debt)
- Core:
  - Exports (types):
    - `AppRef`
    - `PositionalRouteParams`
    - `RouteDef`
    - `RouteParams`
  - Exports (values):
    - `defineApp`
    - `defineRoute`
    - `fillSegment`
    - `MissingRouteParamError`
    - `normalizeRoutePath`
    - `parseSegmentParts`
    - `readKeyedParams`
    - `segmentKeyedParamNames`
    - `segmentMatchPatterns`
    - `segmentParamNames`
    - `segmentRequiredParamNames`
    - `splitKeyedPart`
- Test helpers:
  - Web: `@plugins/primitives/plugins/pane/web/testing`
    - `createTestSurfaceStore` — A surface store, bound as the live store so the imperative free functions and the module-level history listener agree with it.
    - `defaultStore`
    - `TestSurface` — A pane surface: `PluginProvider` + the real `PaneSurfaceProvider`.

<!-- AUTOGENERATED:END -->

# pane — design

Why the rules in [CLAUDE.md](CLAUDE.md) are what they are. Read before changing
or removing one.

Reference docs:

- [Unified pane manager v2](../../../../research/2026-04-23-global-unified-pane-manager-v2.md)
  — core design, open questions.
- [v3](../../../../research/2026-04-23-global-unified-pane-manager-v3.md) — full
  params on open, own-only `useParams()`, prefix matching.
- [Miller columns](../../../../research/2026-04-30-plugins-miller-columns.md) —
  the layout renderer.
- [Route-first architecture](../../../../research/2026-05-15-global-remove-after-pane-state.md)
  — the route store as source of truth, the `parent` chain as from-scratch
  ancestry.
- [`options` vs `hint`](../../../../research/2026-07-10-global-pane-input-hint-vs-options.md)
  — why non-URL state is split in two.

## Define a pane

- **Routes live beside their pane by default.** Moving a route to `core/` drags
  every ancestor route with it (the `parent` chain is an import chain), so it is
  done only when a non-`web/` caller must build the link.
- **Optional `:param?`** gives a view of the entity (tab, stage) an address while
  the bare URL stays valid (`proto/x` and `proto/x/compare`). It claims both URL
  shapes for collision checking.
  - Limit: the parser cannot tell an optional value from the next URL part of a
    pane that has not loaded yet.
- **Keyed params `;name` are matrix params, not `?query`.**
  - Why: in a multi-pane URL each part belongs to one pane, so the key is scoped
    to the pane declaring it. A query string is one bag every column would
    compete for.
  - It also stays in the pathname, which every routing consumer already
    carries.
  - An undeclared key is dropped rather than rejected: the pane shows its
    default view, never a dead link.
  - They don't count as "paramful" for `useResolve`: they view an entity, never
    address one.
- **Surface view keys `;view.<surface>`** are undeclared because the key derives
  from the surface's own id.
  - Any number of surfaces bind side by side in one pane, and a plugin
    contributing one section of a pane it does not own declares nothing.
  - The `view.` prefix keeps the family disjoint from declared keys
    (identifiers, no `.`).
  - Re-opening the pane already shown keeps them (`sameAddress`): an open never
    supplies them, so it must not wipe them.
- **The index pane is not a slot** (an empty route shows it), which is why its
  keyed params live beside the route in the store rather than on a slot.
- **`useResolve` is required for a paramful route** so a paramful pane can
  always say "no such entity".
  - It is `use`-named because its value is a hook: the guard calls
    `useResolve(params)`, so the React Compiler treats the call as a hook and
    never memoizes it.
  - `ResolveResult` reuses the vocabulary by-id domain reads (`useRun`,
    `useReport`) already return, so those are passed through as is.
  - `found` is sticky through later `pending` / `error`, so a transient refetch
    or failure doesn't unmount a pane the user is working in; only `missing`
    does.
  - `error` exists so a failed read is never disguised as `found` (painting
    stale/empty data) or `pending` (an endless spinner).

### `usePaneViewParam` — the view on screen, in the URL

- `set` replaces the history entry because a view switch is not a navigation
  Back should step through.
- Nothing is claimed or coordinated: each surface owns its own key.

## Query the route from outside a pane

**Why `useOpenedHere()` exists.** `useRouteEntries()` cannot answer "which instance did I open?". The heuristics
used in its place each fail:

- "The last entry, but only if there are two" goes blind whenever the calling
  surface's pane was not itself opened from one.
- "The last entry" walks off to a grandchild as soon as the column you opened
  opens another beside it.

`useRouteEntries()` remains right when the question is about the whole chain
(the sidebar's "which conversation is the user reading" wants the deepest
column).

**Why reads throw outside a surface, but opening doesn't:**

- Reads throw rather than return `null`: outside a surface there is no route,
  and a plausible-looking `null` would read as "this pane is not in the route".
  Same policy as `usePaneStore()`.
- Opening is a different requirement. A control reusable enough to appear both
  inside a pane and in a popover (a config gear, an active-data chip) is
  written once; if opening required a surface, it crashes on arrival in the
  popover.
- `useOpenedHere()` is the read half of opening, so it must go wherever
  `useOpenPane` goes or every opener widget crashes in popovers.
  - Its `null` there is true, not a stand-in: a caller with no route opens into
    the focused tab with no position, so nothing it opened is "here". Its
    toggle always opens and never closes a column in a tab it cannot see.

## Non-URL state: `options` and `hint`

The incident behind the split: a single `input` bag made a possibly-absent
display hint look like ordinary pane data. A deep-linked song seeded an
app-context mirror with `input.title ?? "Untitled"`, and a chord-grid autosave
wrote `"Untitled"` over the song's real name. See
[song title single owner](../../../../research/2026-07-10-sonata-song-title-single-owner.md).

- **`options` declare defaults, not a type.** The default is the deep-link value,
  stated once; that is what makes `useOptions()` total, so no read site invents
  its own fallback.
- **`Hint` holds no data.** `pick(key, canonical)` requires the canonical value,
  so a hint cannot be read apart from its source of truth — and whoever holds
  the truth has no reason to write the hint.
- **A hint is never serialized**, so it cannot outlive the navigation that
  created it.
- **`?? <Placeholder>` is allowed** because a ReactNode can never be written back
  as a DB value; a string fallback can.
- Limit: `no-hint-fabrication` sees only the read site. It cannot judge the
  *declaration* — an option whose default lies about server state is a
  misclassified hint, caught only by review.

## Navigate

- **Module-level `openPane` accepts only `root`.** With no caller position there
  is nothing to be relative to; starting a fresh route is the one honest thing
  it can do.
- **`useOpenPane()` is legal everywhere** because opening is imperative: the hook
  returns a callback and reads nothing during render. The store is resolved at
  click time, not render time, because global chrome outlives the tab it was
  rendered beside.
- **Links, not `onClick`.** Both halves of `openPane.link` run the one pure
  `computeOpen`, so the URL a link hands the browser cannot drift from what its
  click does. The URL is computed at click time against the route then on
  screen.
- **`useSetParams` vs `swap`.** A view switch keeps the instance (collapse,
  options, right-hand panes); showing a different entity is a `swap`, which
  mints a fresh instance so nothing of the old one leaks.
- **`append`** exists for global chrome: a popover in the action bar has no
  caller, so its `push` would rebuild the route instead of opening beside it.
  Replacing a same-type last pane means a preview opened again swaps its column
  rather than stacking.
- **Caller-less `push` / `swap` differ from `root`** on purpose: `root` always
  discards the route (like clicking a sidebar entry), while a caller-less push
  reuses the target's existing slot when it is already shown.

## Chrome

- **No opt-out from `PaneChrome`**, so a pane can never strand its own
  scrolling.
- **A rich header is just more items** (transport, view switcher, volume). The
  title is an item of the same slot, so a rich header collapses into the `⋯`
  like any other; a leading/trailing split is a `spacer` in the reorder config
  rather than a field on the contribution.

### The title (`Pane.define({ title })`)

#### No side door into the header row

- Any header-content prop (a `title` / `extra` node) is a door through which a
  whole second slot gets smuggled into the row (e.g. an app's own
  `HeaderActions` slot rendered as one node). Items in a smuggled slot escape the
  row's order, overflow and `⋯`, and nothing can be placed beside the title.
- The title-cell guard is a slot LIST middleware, which runs once per
  `.Render` — so it catches render slots only. Plain and dispatch slots painted
  once inside a title (a breadcrumb separator) are part of the title.

#### Tab / document title ownership (`titleOwner`)

First-owner-wins gives the right answer in both directions from one static
declaration:

- aux panes stacked to the right (file peek, review, terminal) never steal the
  title;
- the same conversation pane opened as a drill-in under a task stays
  subordinate to it.

Rejected: "the leaf pane's title" — every aux pane would retitle the tab. It
stays only as the fallback when no pane owns the title.

#### Title typography is container-owned

The size comes from the container so every pane title shares one baseline;
per-segment weight/color (a breadcrumb's muted parts) still composes on top.

### `PaneScroll` — the sanctioned pane-body scroll viewport

One viewport per body means toolbars and section headers pin as `<Sticky>`
against it instead of each owning a nested scroller. In the header + body case,
PaneChrome's own scroll is naturally inert (`h-full` fills it exactly).

### `PaneChrome` props

- **`floatingHeader`**: a header above the scroll can never show anything behind
  it, so a page designed to run up behind its header (the website's hero glow)
  needs the header inside the scroll.
- **`headerTheme`**: for a page whose picture under the header is in another
  palette than the page (a white sky, then black water). The bar masks with
  that theme's own background, republished as `--chrome-mask`.

### `inset="content"`

- An unset `contentInset` (`initial`) makes `--pane-inset` invalid, so every
  reader falls back to the chrome pad: opting in is free until the theme says
  otherwise.
- The container makes `cqi` a fraction of the **pane**, not the window (e.g.
  `max(clamp(16px, 3cqi, 40px), calc((100cqi - 1520px) / 2))`).
- Card rows read their own tokens (`chromePaneCardH`, …, defaulting to the
  bar's), so a theme growing the bar for a split header leaves card rows as they
  were.
- A `header="card"` row keeps its own inset — the card is a floating chip, not an
  edge.
- The `data-part` names are data-view's parts vocabulary, spelled literally
  because the pane cannot import data-view.

### `header="card"`

- Not an `AdaptiveBar`: a content-sized card has no width of its own to run out
  of, so there is nothing to collapse into a `⋯`.
- `orientation="host-owned"` so an item that hides itself leaves no gap.

### The header slot (`Actions`)

- **Exactly one renderable form** makes an item that would render nothing
  unconstructable.
- **No `position`**: order, hiding and grouping are the reorder config, like every
  other render slot. Packing against the trailing edge by default is what a pane
  header wants.
- **The title item is minted on the slot-declaration pass** because a slot is
  only *named* by that pass, and `Pane.define` runs at each pane plugin's module
  scope — there is no earlier moment at which the set of headers is knowable.
- **`cell: "yield"` is a public, generic field**, so the title is not a special
  case and another plugin could occupy the yielding cell.
- **The tab title reads the declaration, never the slot**, so hiding the title
  item in the order file cannot blank the tab.
- **Overflow moves the same live element** behind `⋯`, never a second copy, so
  an item's state survives collapsing. The title cell is never measured,
  demoted or relocated.

### A header shared by several panes (`Pane.define({ actions })`)

- Borrowing gives one slot, one contribution list and one config directive for
  every pane wearing the header.
- `Pane.define` mints through `definePaneHeaderSlot()` too, so a borrowed header
  and an auto-minted one are the same kind of slot.

## Router

### The `HistoryAdapter` seam

- The URL + `history.state` are a pure projection of the store, written only
  through the adapter, so the pane primitive stays app-agnostic.
- **A hard event contract** (programmatic ⇒ `shell:navigate`, traversal ⇒
  `popstate`) rather than idempotency-by-comparison.
- **The sink defaults to `defaultHistoryAdapter`**, so the slot is never empty
  and teardown never has to remember the default.
- **The tabs adapter stores whole snapshots** and restores them (refocus the tab,
  re-sync its app, restore the route) with zero URL parsing.
  - `appInstance` names one running SPA app-state, of which a browser tab hosts
    a sequence. It lets a cold boot tell "restore the state this entry belongs
    to" from "this entry came from somewhere else".

### The address bar is untrusted input

Concrete failure modes of a raw `window.location.pathname`:

- **As a history URL**: `replaceState(s, "", "//agents/c/x")` resolves to
  `http://agents/c/x` — a different origin — and throws `SecurityError`. A deep
  link with a doubled slash crashes boot.
- **As a match key**: `"//agents/c/x".startsWith("/agents/")` is false, so the
  URL owns no app and silently falls back to the default app.

Because the boot replace-stamp commits the canonical path, a slash-mangled deep
link also self-heals: the address bar is rewritten in place to the working URL.

## Testing

- `TestSurface` wraps the real `PaneSurfaceProvider`, so a context that moves
  into the surface reaches every suite at once. Hand-picked contexts break
  every suite that forgot the new one.
- `live: true` is the default because `handleLocationChange` early-returns for a
  background store: a `live: false` store never reads `window.location`, and
  every deep-link case silently resolves empty.

## A pane's home app, and what Expand means

- **Why `app` exists**: panes are reusable chrome — the agent manager hosts the
  page detail beside a conversation. Where a pane renders says nothing about
  where it belongs.
- **Mandatory, no opt-out**: being displayable in any app is a fact about
  hosting, not an absence of ownership. The apparent exception (the theme
  customizer restyles whichever app you're in) still has a home: Appearance is
  a Settings surface.
- **Imported from the shell's `core` barrel**: that leaf holds only
  `defineApp({...})`, so it can never close an import cycle. Test fixtures define
  a local app to keep this primitive's suites free of `plugins/apps`.
- **`AppRef.name` is the single authoring site** of an app's display name, so the
  rail, tab fallback and Expand never restate it.
- **Cross-app Expand is offered even at position 0**: `/agents/page/X` is a page
  stranded in the agent manager, precisely the case worth fixing.
- **`usePromote()` returns the destination**, not just a way to get there, so the
  chrome can label itself ("Open in Pages" vs "Expand pane").
- **Why a navigation sink**: `apps-core/tabs` imports this primitive, so it
  cannot be imported back. Tabs installs its `navigate`, as it installs its
  history adapter; the pane layer reaches a cross-app destination without
  knowing tabs exists. `useInstalled()` subscribes, so a late install re-renders
  whoever asked early.

### A route belongs to its root pane's app

The incident: from Places, a Settings setup pane opened in place became
`/places/accounts/google-maps/live-map` — full screen, with no Settings around
it. A route headed by another app's pane is that app's surface stranded in this
one.

- Opening re-routes to the home app transparently, so there is no second,
  cross-app spelling of `openPane` to remember.
- With no navigator installed the open throws: painting the route here is the
  bug.
- The surface's side of the comparison is its base path, as for the index pane.

### A pane wears its home app's theme

- The scope is forwarded across portals so a pane's popovers and menus keep it,
  and collapsed Miller columns wear it so collapsing a guest pane doesn't snap
  its rail back to the host's colors.
- Limit: an app that has not forked its theme emits no scope block, so its
  panes inherit `:root`, which carries the focused (host) app's theme. Guest
  panes of unforked apps therefore still look like their host (see the `theme`
  skill).
- Color mode is decided by the app owning the document
  (`defineApp({ colorMode })` plus the user's override); one `<html>.dark` per
  document is why a pane can switch tokens but never the scheme.

### The app's index pane (`appIndex`)

- A boolean, not a path: *which* app's root is `app.basePath`, which the pane
  already carries.
- No global fallback: an empty main area at an app's bare root is a legitimate
  choice, not an error to paper over.

### Companion panes (`companion`)

The case: a file chip clicked in the agent manager's home composer (`/agents`,
an empty route) should open the preview beside the home, not replace it, and
`/agents/attachment/<id>` should reload to the same two columns. Keeping the
index in the match (not the route) gives both without touching the URL — the
index stays the landing, never a column the route carries.

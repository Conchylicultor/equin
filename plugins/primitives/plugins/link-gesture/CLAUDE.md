# link-gesture

`linkProps({ open, href })` → `{onClick, onAuxClick, onMouseDown}` for any
control that navigates: plain click runs `open()`, ⌘/Ctrl- and middle-click open
`href()` in a new **browser** tab — what the same gesture does on an `<a href>`.

The browser grants these gestures to `<a href>` only, so a `<button>` that
navigates must read them itself — this is the single place that happens, which
is what keeps every such control agreeing on what a ⌘-click means.

- `href` is a thunk, evaluated synchronously in the click handler and only for
  an "elsewhere" gesture: synchronous so `window.open` is still a user gesture
  (not popup-blocked), at click time so a destination relative to the screen (a
  pane pushed beside its caller) is computed against what the user clicked on.
- `openInBrowserTab(url)` is the one spelling of "open this in a new browser
  tab": an app path of this origin or an absolute URL (`noopener`, plus
  `noreferrer` off-origin). A *button* that does it is not hand-built from this:
  it is the `new-tab` child plugin's `NewTabButton` / `NewTabMenuItem` /
  `NewTabLink`, which own the glyph and the behaviour together.
- `activationProps(activation, { isolate? })` spreads an `Activation` (a
  `LinkTarget` gets the full gestures, a plain action only `onClick`,
  `undefined` nothing). `isolate: true` stops propagation of `click` and
  `auxclick` (never `mousedown` — editor drag/selection need it) before acting:
  the one answer for a chip inside a clickable row or the page editor.
- **In a static render, `href()` runs during render** and lands in the markup as
  `data-link` (`linkProps`, and so `activationProps` with a `LinkTarget`,
  isolated or not, `appLinkProps`, `openPane.link`). That HTML (the website's
  crawlable snapshot, `dom/render-mode`) is never hydrated, so no click ever
  computes the destination; the snapshot's filter turns `[data-link]` into
  `<a href>`. A throwing `href()` fails that render. On a live page there is no
  `data-link` and `href()` still runs only on click. A component that forwards
  link props by picking handlers one by one drops it — spread the whole bag
  (`LinkChip` spreads it, then chains the handlers).
- `linkGestureProps(open)` is the low-level form — `open({ elsewhere })` decides
  what "elsewhere" means. Only for a control whose elsewhere is not a browser tab
  at an app path (open-app's button, whose default flips between a browser tab
  on another origin and a framed pane). Prefer `linkProps`.

## ⌥/Alt-click: keep the others — the `Gesture`

`LinkTarget.open(gesture)` takes a REQUIRED `Gesture` (`{ keepOthers }`, read
off the event by `gestureOf(e)`; `PLAIN_GESTURE` where there is no input to
read). `linkProps` / `activationProps` / `linkGestureProps` pass it; the pane
store acts on it: an open inserts beside the caller instead of replacing what
is right of it, a close removes only that pane. Required, so a wrapper that
forwards a link (a toggle, `afterOpen`, a row activation) cannot drop it — a
bare `open()` is a type error. `runActivation(activation, gesture)` likewise.

A new in-app (equin) tab is not a link gesture: it is reachable only from
an explicit menu entry (`navigate(url, { newTab: true })`).

- `browserTabAddressSink` decides how `openInBrowserTab` writes an in-app
  path: `apps-core/tabs` installs the tab set the user is in's address (the
  page's: under its route prefix; an app embed's: its host's, `/demo`'s
  full-screen demo at that place). Until installed, the page's route prefix.

A leaf on purpose (imports only React's `MouseEvent` type, the
`scope/install-sink` leaf, the `dom/render-mode` leaf, and the `pane/route-prefix` leaf, whose prefix
`openInBrowserTab` puts in front of an in-app path by default so a desktop's
link opens a desktop), so both the pane
primitive (`useOpenPane().link`, Promote) and `apps-core/tabs`' `appLinkProps`
compose it without either depending on the other.

## Openers return a `LinkTarget`, never navigate

Anything that names a destination hands it over as DATA — a `LinkTarget` (or an
`Activation` where a plain action is also legal) — and the control that renders
it spreads `activationProps` / `linkProps`. An opener hook therefore returns a
function that BUILDS a target (`openPane.to(…)`, tabs' `appLink(url)`, a
presenter's `useTarget()`, `useConfigLink()`, `ExplorerNavigator.to(…)`), not
one that navigates: a callback that navigates cannot be ⌘/middle-clicked, and
every primitive taking `onClick` / `onOpen` / `onNodeClick` instead of an
`activation` was a control that silently lost the gesture. Imperative opens stay
for the cases with no gesture to read — `onSelect` (a picker), after a mutation
(`onCreated`), keyboard shortcuts.

**A dropped link is a type error.** `Activation`'s function arm is `Action =
() => void | undefined`, not `() => void`: TypeScript ignores the return of a
function assigned to a bare `void` return, so `() => openPane.to(…)` — or a
resolver `(r) => () => linkTo(r.id)` — would type-check and the click would
build a `LinkTarget` and discard it. With `void | undefined` the return is
checked, so a function returning a value (a `LinkTarget`, a Promise) is
rejected; pass the target itself, or `() => void promise()`. Pinned by the
`@ts-expect-error` cases in `core/internal/activation.test.ts`.

**Everywhere else, a dropped link is a lint error: `link-gesture/no-discarded-link`**
(closed, type-aware, `lint/`). tsc cannot reject a value returned into a plain
`() => void` (React's `onClick`, a component's own `openTrash: () => void`,
`forEach`) and has no must-use return — the Prototypes Trash button shipped as
`openTrash={() => openPane.to(…)}` and was dead. The rule is keyed on the TYPE
(any value with callable `open` and `href`), not on names, so it catches every
producer (`openPane.to`, `appLink`, an opener's target) under any prop name. It
reports a link-valued expression statement (`openPane.to(…);`, `void appLink(u);`),
a function literal returning a link where its contextual return is exactly
`void`, and a function value returning a link passed where a `() => void` is
expected (`onClick={go}`). Fix: spread `openPane.link(…)`, pass the target as
an `activation`, or — with no gesture to read — call `openPane(…)` itself.

**A link run through a callback is a lint error: `link-gesture/no-dropped-gesture`**
(closed, `lint/`). `PLAIN_GESTURE` means "no gesture to read"; inside a
clickable `on*` handler (`onSelect={() => runActivation(link, PLAIN_GESTURE)}`,
`onAction`, `onFilterRow`, …) it is a link forced through a component that only
takes a callback — the Configure gear, Open theme editor, Open as page, New app
and the analytics overview rows all shipped that way. Keyed on the gesture
being discarded, not on the prop name, so it reaches what `no-click-navigate`'s
fixed prop list cannot. Allowed: key handlers, value changes, past-tense events
(`onCreated`, `onDeleted` — an open after a mutation). Fix: give the component
an `activation` (an `Activation` / `LinkTarget`) it spreads `activationProps` /
`linkProps` from — as `ControlPanel.Row`, DataView's `CreateOption` and the
ui-kit `MenuRowAction` take.

`LinkChip` makes it a type: `onClick?: never` / `onAuxClick?: never`, so a chip's
click is its `activation` (a plain function for a chip that does something other
than navigate — still isolated from its container).

**Lint: `link-gesture/no-click-navigate`** (closed, `lint/`) flags a callback
whose whole job is one navigating call — `openPane(…)`, the tabs barrel's
`navigate(…)` (not with `{ newTab: true }`), a call on a `useOpenPane()` /
`use*Opener()` binding, or a hand-run `<target>.open()` —
optionally after `stopPropagation` / `preventDefault`. It fires on handler props
(`onClick`, `onRowClick`, `onRowActivate`, `onNodeClick`, `onOpen`,
`onActivate`, `onNavigate`, `onOpenFile`, `onFileOpen`; inline or a same-file
named handler) and on activation props (`activation`, `rowActivation`,
`nodeActivation`, `commitActivation`) whose value is such a callback or a
resolver returning one. Fix: spread `openPane.link(…)`, or pass `openPane.to(…)`
/ `appLink(url)` as the `activation`. A genuine non-link escapes per site with
`// eslint-disable-next-line link-gesture/no-click-navigate -- <reason>`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The browser's link gestures as spreadable handler props: plain click opens here, ⌘/Ctrl- and middle-click open the destination's URL in a new browser tab, ⌥/Alt-click opens it here keeping the others (a Gesture passed to LinkTarget.open: a pane open inserts beside the caller, a pane close removes only that pane). A <button> gets none of this for free, so every navigating control reads it from one place.
- Web:
  - Uses:
    - `primitives/pane/route-prefix.withActiveRoutePrefix`
    - `primitives/scope/install-sink.defineInstallSink`
  - Exports (types): `LinkGestureProps`
  - Exports (values):
    - `activationProps`
    - `browserTabAddressSink`
    - `gestureOf`
    - `linkGestureProps`
    - `linkProps`
    - `openInBrowserTab`
- Cross-plugin:
  - Imported by: 79 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `conversations` ×21
    - `primitives` ×19
    - `apps` ×12
    - `tasks` ×5
    - `page` ×4
    - `apps-core` ×3
    - `debug` ×2
    - `hints` ×2
    - `shell` ×2
    - `build`
    - `code-explorer/file-resolve`
    - `config_v2/config-link`
    - `infra/claude-cli/sign-in`
    - `integrations/google-maps/usage`
    - `plugin-meta/plugin-view`
    - `review`
    - `search/quick-find`
    - `ui/theme-engine/quick-theme`
- Core:
  - Exports (types):
    - `Activation`
    - `Gesture`
    - `LinkTarget`
  - Exports (values):
    - `activationHref`
    - `afterOpen`
    - `beforeOpen`
    - `PLAIN_GESTURE`
    - `runActivation`
- Sub-plugins:
  - **`new-tab`** — The new-browser-tab control in every form — NewTabButton (icon or text), NewTabMenuItem, NewTabLink, newTabAnchorProps for a component rendered as a link, NewTabGlyph for a container that is one…

<!-- AUTOGENERATED:END -->

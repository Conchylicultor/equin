# canvas

The prototype detail pane (`proto/:name`): one prototype shown as a
canvas of **frames** side by side — so a reader can put
two variants, two versions, or the mock and the real app next to each other
and look. Design: `research/2026-09-23-apps-prototypes-frame-canvas.md`
(mockup: prototype `proto-1790120832-wtfo`).

## The model

A frame shows one of two things:

- **the prototype** — one recorded version (or the live folder) under one set
  of option picks. Each prototype frame has its own version stepper in its
  header and its own options pill over its screen;
- **a frame source** — something that is not the prototype, contributed to
  the `FrameSource` slot (below). `compare` contributes the **Real app**: the
  real screen the prototype declares it mocks.

Everything else is **canvas-wide**: one size, one zoom, Whole page on or off,
and — with exactly two frames — Side by side or Swipe. Frames never have sizes
of their own, which is what makes them comparable.

`internal/canvas-model.ts` is the state as pure data, and `canvasReducer` is
the only way it changes. What the reducer cannot do itself — write the
prototype's shared picks record, which lives on the server — it returns as
**effects** (`setShared` / `resetShared` / `replaceShared`) that the provider
(`PrototypeDetailProvider`, `context.tsx`) runs. So every rule below is
unit-tested without a DOM or a server. `internal/layout.ts` (size, zoom, Whole
page and the measured room → each frame's logical size and scale) and
`internal/frame-name.ts` are pure and tested too.

The canvas belongs to ONE prototype: the provider holds it together with the
prototype's name, so opening another prototype opens its own canvas without an
effect resetting anything.

## Remembered per pane, for the tab's session

A comparison is a throwaway: it lives as long as the browser tab showing it,
and no longer. The detail pane's canvas — frames, their versions and own picks,
selection, size, zoom, Whole page, Swipe, link and spread — is saved in the
tab's **sessionStorage** (`persistent-draft`, `storage: "session"`), keyed by
the pane instance (its route-entry `uuid`, which the tab set and
`history.state` restore on reload) and the prototype. So:

- a **reload** reopens the canvas as it was left, and so does Back to it;
- two app tabs, or two browser tabs, on one prototype each keep their own;
- a **new** pane — another tab, a link, the address bar — starts fresh at
  frame A alone. Nothing carries over to a new session.

`dispatch` is the one place the canvas changes, so it is the one place it is
written; the provider reads it synchronously when the canvas opens, so the
first paint is already the saved canvas.

Frame A's picks are not in it: A holds `"shared"`, a pointer to the server
record, which stays their only truth. `internal/saved-canvas.ts` validates what
it reads back (a zod schema plus the reducer's invariants — one `"shared"`
frame and it is A, ids below `nextId`, the selection on the canvas); anything
else opens a fresh canvas with a console warning. Swipe with other than two
frames is not a rejection: `settleLayout` (applied to every reducer output, and
on restore to canvases saved before it was) puts such a canvas side by side.

Remembering is opt-in (`remember={uuid}` on `PrototypeDetailProvider`): only
the detail pane asks for it, never Present's one-frame page, and never inside an
embedded document — a framed copy of the app must not rewrite the host's
canvas. A reopened source frame whose plugin has not loaded yet (they load in
a later tier) reads `loading` in the dispatch fallback until the deferred tier
completes, and only then "nothing shows these frames".

## Frame A holds the shared picks

The option picks a person makes are, first of all, `files`' ONE shared record
per prototype (`prototypes.picks`, `_picks/<id>.json`): every tab, every
deploy and `./singularity prototype options <id>` see it, live. **Frame A** —
the first prototype frame — reads and writes that record. Every other
prototype frame holds picks of its own, local to this pane, so trying a variant
in B never changes what anyone else sees.

The invariant is kept by the reducer (`promoteA`): whenever a different frame
becomes A (A was closed, Keep only kept another frame, a spread put another
frame first), that frame's own picks are written to the shared record, so what
is on screen does not change; and the frame that stopped being A keeps what it
showed as picks of its own. Undo after Keep only puts back the record as it was.

The shared record (the `prototypes.picks` live value) is read through
`useOptimisticResource`: a chip answers the click at once, and a failed write
stays on screen and shows in the sync-status cloud. Until the record is known
the canvas does not exist at all — `PrototypeDetailProvider` renders a loading
block (or the load error), exactly as it does for the prototype list — so no
frame opens on a guess of the defaults and then swaps, and no pick can be
folded onto a record nobody has seen (the hook has no `dispatch` while
pending). The provider is keyed by prototype, so pointing a pane at another
prototype starts a fresh overlay instead of replaying the old one's picks onto
it. Picks are judged per document: a frame's options are those its
own version declares (`documentOptions`), and a stored pick that version does
not declare is dropped from its URL.

## Frames: add, copy, link, spread, keep only, close

- **`+ Frame`** (header) adds a copy of the LAST prototype frame — same version,
  same picks — ready to change its variant or version. A frame's own
  **Duplicate** action copies that frame instead.
- **`+ <addLabel>`** — one button per frame source ("+ Real app"), disabled
  while that source is already on the canvas. The canvas names no source.
  Adding one switches the canvas to Swipe (when that makes two frames) at
  Responsive size — a source frame is there to be compared against.
- **The options pill** ("Mist · Home +3") opens on click into "Options":
  one row per declared option — value chips for a choice; for a color, one
  swatch per suggestion and a trailing custom swatch (the color on screen,
  ringed when it is no suggestion) that opens the color picker in its own
  popover above the swatch. The pill writes a color as a dot and its suggestion's
  name, or its hex. Options the page declares under a group
  (`<meta name="prototype-option-group">`, `files`' `groupOptions`) sit in one
  collapsible section per group — folded, its header lists the group's picks —
  and a grouped row drops the group's prefix from its label (`optionLabel`;
  its radiogroup keeps the whole humanized name, so it stays unique). Per row:
  - **link** — keep this option the same in every frame; linking copies this
    frame's value everywhere, and later picks go to every frame;
  - **spread** — one frame per value of this option — for a color, per
    suggestion, with the frame's own custom color first when it is none of
    them (the frame it was toggled from keeps its place, the others are copies
    of it with that one value changed); toggled again, it gathers back into
    that frame. A pick of the spread option breaks the spread. A color with
    nothing to spread over offers no spread.
  The pill is app DOM over the frame, never inside the prototype's page — that
  is what keeps switchers out of the designs.
- **Keep only** closes every other frame, with an Undo toast.
- **Close** removes one frame. The canvas never goes empty: with one frame
  left, Keep only and Close are not offered.

Frames are named from their picks (`frameName`): the values of the first two
options, plus any other option on which the frames differ — so two frames never
share a name while showing different things. A source frame is named by its
add label.

## Color options: live, without a reload

A choice pick reloads the frame (its `src` carries the pick). A color pick
never does — a drag would reload the page on every move. Instead:

- **The `src` is frozen against color-only changes** (`useFrameSrc`): it is
  rebuilt when anything else in it changes (a choice, the version, an edit's
  cache-bust), and then carries the color picks of that moment, so the new
  document arrives server-stamped (no flash of the default colors). A color
  change alone leaves it as it is.
- **The colors are painted into the document**: `useFrameColorVars` gives each
  color option's color (preview ?? pick ?? default, as `#rrggbb`), and
  `PrototypeFrame` sets them as `--<name>` on the shown document's `<html>`
  (`internal/color-vars.ts`, the same pattern as the screen height), and on an
  incoming document in its `load`, before it replaces the one on screen.
- **Preview, then commit.** Every move of the picker dispatches `previewPick`:
  `CanvasState.preview` (`{ id, option, value }`, one at a time) is local and
  never saved (`isTransientAction` skips the save; `serializeCanvas` leaves it
  out). It shows on its frame, or on every frame when the option is linked
  (`previewedValue`). The drag's end (and a swatch, a field commit) dispatches
  the ordinary `setPick` — ONE write of the shared record, which every other
  tab follows live — and that clears the preview. Closing the popover drops an
  uncommitted preview.

## Versions

Each prototype frame's header has `‹ v14 · latest ›` (`version-stepper.tsx`),
over `files`' per-prototype history resource. It moves only its own frame. The
stops are derived on every render from the history (`version-steps.ts`): the
recorded versions oldest first, the newest one being the live folder when it
is clean, plus a last "Live · unsaved" stop when the folder has changes no
version holds yet. The label opens the version list ("Versions", a
`DataView` whose row actions are the `PrototypeVersionActions` slot — the
canvas ships **Compare in a new frame** (a copy of this frame, same picks,
showing that version; the stepper hands the frame to its row actions through
`VersionListFrameContext`) and "open the conversation that recorded it"), and on a past version
it ends with **Make vN the latest** (confirm, restore, back to live; the store
saves the current state first, so nothing is lost).

**The arrows never move**: the label has a floor wide enough for every form,
so stepping never slides › out from under the pointer (`canvas-version.ts`
asserts it). Known gap: the stepper sits after the frame's name, and a version
that declares different options gets a different name, so stepping onto it can
shift the whole stepper (the script notes it rather than failing). A recorded version is a frozen document with no cache-bust; the
live folder is cache-busted by its `PrototypeMeta.rev` (a hash of that
prototype's own files), so an agent's edit reloads it — and nothing else does. A new `src` loads in a second, hidden iframe and replaces the one
on screen on `load` (`prototype-frame.tsx`), so a frame never blanks while a
client-rendered prototype boots, and every scroll offset of the outgoing
document is carried onto the incoming one (auto-scroll's `restoreDocumentScroll`: matched
by id, else by DOM path; re-tried as the new document renders, until reached,
the reader scrolls, or 5 s), so a reload keeps the reader's place. Script state
(an open menu, a typed value) is not carried.

## Size, zoom, Whole page

One chip in the canvas's bottom-right corner — "This window 1728 × 990 | Fit ·
62%" (`size-chip.tsx`) — opens the menu for all three:

- **Size** is the logical size every frame's page lays out at: **Responsive**
  (a frame IS its share of the canvas, measured in page pixels at the current
  zoom — the page's own responsive layout shows), **This window** (the size a
  page gets in the viewer's own browser window, `innerWidth × innerHeight`,
  followed live — the room the real app has on this machine, so a mock judged
  here is judged at the density the app will really have), a **device preset**
  (Phone 390×844, Tablet 820×1180, Laptop 1440×900, Desktop 1920×1080, Wide
  2560×1440 — real devices at their default scaling, never CSS breakpoints; a
  frame is that device's screen, and a longer page scrolls inside it), or
  **Custom** (a width slid off the presets). A fresh canvas (none saved in
  this browser) **opens at the size the prototype declares** (`<meta name="prototype-viewport" content="window">`
  — `window`, a preset's name or `responsive`; Responsive when absent), so a mock always
  opens at the screen it was drawn for rather than at whatever room the pane
  happens to have. The presets and that tag's parser are one list, owned by
  `files/core` (`SIZE_PRESETS`, `parseViewport`); the provider waits for the
  prototype list before the canvas exists, so it never opens at a stand-in.
- **The Width slider** in the same menu resizes EVERY frame (the size is
  canvas-wide), in 360–2560 px, snapping onto a preset it moves within 28 px
  of. Only a move toward a preset snaps, so an arrow key can step off one.
- **Zoom** is **Fit** (the default: the largest scale at which the whole frame
  is visible; at Responsive that is 100%) or a fixed scale from the 10–200%
  slider (with a detent at 100%). The value box beside the slider jumps to
  100%. Zoom never changes what the page lays out at — only how big it is
  painted (`transform: scale()`).
- **Whole page** shows each page's entire content instead of one screen: a
  frame is as tall as its document (measured once loaded,
  `use-page-height.ts`), all frames as tall as the tallest, and Fit then fits
  that whole height.

  Not every page HAS a whole height. A page that sizes something from its
  window in script (a `resize` handler reading `innerHeight`) grows with its
  frame, without end. So before a frame is fitted to its page, a hidden twin
  of the document is probed once (`internal/page-extent.ts`): measured at one
  screen, doubled so its scripts react, then read again at one screen before
  any script runs. A taller second read means the page follows its window: the
  frame stays one screen tall, and with no frame left to show whole, the switch
  reads off, disabled, "sized to its window". CSS `vh` alone never trips it —
  it re-lays out synchronously.

  Every prototype frame tells its document the height of one screen, as
  `--prototype-screen-height` on `<html>` (firing `resize` when it changes). A
  prototype that sizes to that instead of `innerHeight` keeps a whole page; see
  `prototypes/CLAUDE.md`.

The layout is computed once by the canvas (`layoutFrames`) and handed to the
chip, so the chip and the frames can never disagree. Layout uses inline styles
only for this dynamic scaling geometry.

## Swipe, selection, keyboard

With exactly two frames the header offers **Side by side | Swipe**; adding
or closing a frame while swiping goes back to side by side. Swipe
paints the two frames in one box, B under A, A clipped at a divider you drag.

Clicking a frame selects it (an accent ring; a new or changed frame becomes
selected). The selection is what the keys act on, registered once for the
canvas as surface-scoped plain keys (silent while a text field has focus):

- `[` / `]` step the selected frame's version;
- `0` toggles the zoom between 100% and Fit.

A selected frame shows its header actions; the others reveal them on hover.

A frame's header is as wide as its screen, so on a crowded canvas it runs out
of room. It is an `AdaptiveBar`: the name ellipsizes to its floor, the version
stepper shrinks to its bare `v14` label (the list still opens; `[` / `]` still
step), and the actions that still do not fit move behind a `⋯`. The hover
reveal hides an action only while it sits in the row
(`hoverRevealTargetInAnchor`), so one in the `⋯` panel is visible there.

## The URL

The URL names only the prototype: `proto/<id>` (what the CLI prints). What is
on its canvas is remembered for the pane (above), so the URL and the saved
canvas can never disagree about it. The route lives in `shell/core/routes.ts`,
so the gallery can open this pane without either plugin depending on the
other.

## Extension points

- **`prototypeDetailPane.Actions`** — the pane header IS the action bar. The
  canvas contributes the layout switch and the add buttons; `copy-id` the copy
  button; `gallery` the Done toggle. Order: `config/apps/prototypes/canvas/`.
- **`PrototypeFrameActions`** — a frame's header actions, handed
  `{ frame, meta }`. The canvas ships Keep only, Duplicate and Close; `present`
  adds its Present menu.
- **`FrameSource`** — a dispatch slot keyed on the source id: `{ match: "<id>",
  addLabel, component }`. The component is handed `{ source, meta, children }`
  and its only output is `children(resolution)` — `loading`, `unresolved
  { title, detail }` (prose, painted in the frame) or `found { tag, href?,
  render(width, height) }`. It paints no layout of its own, so a source frame is
  always the canvas's size; `render` runs inside an error boundary, so a
  crashing source costs its own frame only. An unknown id renders the
  `UnknownFrameSource` fallback.
- **`PrototypeVersionActions`** — row actions in the version list.

For surfaces that show a frame outside the pane (Present, its new-tab page)
the barrel exports `PrototypeDetailProvider` (standalone for one frame, with
`initialVersion` / `initialPicks`; or on a whole given canvas, with
`initialCanvas`), `PrototypeCanvas` (the pane's body, for a page drawing the
whole canvas), `encodeCanvas` / `decodeCanvas` (the canvas as one url segment,
validated like a saved one), `usePrototypeDetail`, `CanvasFrameView`
(the very same frame screen), `OptionsPill`, `VersionStepper`, `SizeChip`,
`layoutFrames` and `useFrameNames`.

## Driving it from outside: the DOM contract and e2e

Every frame's screen carries `data-canvas-frame="<letter>"`,
`data-canvas-frame-kind` (`prototype`, or the source's id — the canvas
publishes the id it was given) and `data-canvas-frame-status` (`loading` /
`unresolved` / `found`). Side by side, each frame's card (header, screen,
options pill) carries `data-canvas-card="<letter>"`; the canvas root carries
`data-canvas-layout` (`side` / `swipe`, as drawn). Swiped (what adding a
source frame does) there are no cards, so a flow needing a pill or one screen
alone calls the driver's `setLayout(page, "side")` first. The
names and selectors live in `core/`, the one spelling the canvas and an `e2e/`
script both read.

`e2e/index.ts` holds the shared flows (open a canvas, add a source frame by
its add label, find a frame, read back
the size, version and picks its document was opened with — off the iframe's
`src` and box, so assertions are about what is on screen). The scripts, all
manual, default to the first prototype declaring an option with 3+ values and a
`mocks` counterpart (`--name` to choose):

- `canvas-frames.ts` — + Frame copies the last frame, B's picks are its own,
  link, spread and gather, Keep only + Undo, Close;
- `canvas-size.ts` — presets, Fit vs 100% and the slider, Whole page, Width
  slider snap;
- `canvas-version.ts` — the per-frame stepper moves only its frame, arrows
  stay put;
- `canvas-remember.ts` — a fresh browser opens A alone; frames, size and zoom
  come back on a reload, the URL never changes, a closed frame stays closed,
  a frame added while swiping survives a reload, and opening the prototype
  anew starts at A alone.

Each script's session is a fresh browser context and opens the canvas by a new
navigation, so it starts from nothing remembered.

`compare/e2e/compare-diff.ts` photographs frame A against the real-app frame.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The prototype detail pane as a canvas of frames: the prototype (frame A reads and writes the shared option picks, every other frame holds its own), each with its own version stepper and options pill, beside frames from contributed sources (FrameSource — the real app, from compare); one canvas-wide size & zoom chip (Responsive / device presets / custom, Fit or 10–200%, Whole page), a Width slider that resizes every frame and snaps to the presets, side-by-side or swipe, keep-only with Undo, link and spread across frames; the whole canvas is remembered per pane for the browser tab's session, so a reload reopens it as it was left while a new pane starts fresh.
- Web:
  - Slots:
    - `prototypeDetailPane.Actions`
    - `PrototypeFrameActions`
    - `FrameSource`
    - `PrototypeDetailWrap`
    - `PrototypeVersionActions`
  - Slot contributors:
    - `prototypeDetailPane.Actions` ← `apps.prototypes.canvas`
    - `prototypeDetailPane.Actions` ← `apps.prototypes.copy-id`
    - `prototypeDetailPane.Actions` ← `apps.prototypes.gallery`
    - `prototypeDetailPane.Actions` ← `apps.prototypes.present`
    - `prototypeDetailPane.Actions` ← `primitives.pane`
    - `PrototypeFrameActions` ← `apps.prototypes.canvas`
    - `PrototypeFrameActions` ← `apps.prototypes.present`
    - `FrameSource` ← `apps.prototypes.compare`
    - `PrototypeDetailWrap` ← `apps.prototypes.present`
    - `PrototypeVersionActions` ← `apps.prototypes.canvas`
  - Contributes:
    - `Pane.Register` "prototypes-detail"
    - `prototypeDetailPane.Actions` "layout" → `LayoutAction`
    - `prototypeDetailPane.Actions` "add" → `AddFrameActions`
    - `PrototypeFrameActions` "keep-only" → `KeepOnlyFrameAction`
    - `PrototypeFrameActions` "duplicate" → `DuplicateFrameAction`
    - `PrototypeFrameActions` "close" → `CloseFrameAction`
    - `PrototypeVersionActions` "compare" → `CompareVersionAction`
    - `PrototypeVersionActions` "open-conversation" → `OpenVersionConversation`
  - Uses: 80 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×8
    - `primitives/data-view` ×6
    - `primitives/collapsible` ×5
    - `primitives/hover-reveal` ×3
    - `primitives/persistent-draft` ×3
    - `primitives/action-presentation` ×2
    - `primitives/css/control-panel` ×2
    - `primitives/css/spacing` ×2
    - `primitives/css/text` ×2
    - `primitives/css/toggle-chip` ×2
    - `primitives/dom/auto-scroll` ×2
    - `primitives/dom/element-size` ×2
    - `primitives/latest-ref` ×2
    - `primitives/live-state` ×2
    - `primitives/optimistic-mutation` ×2
    - `primitives/pane` ×2
    - `primitives/slot-render` ×2
    - `apps-core/tabs.appLinkProps`
    - `infra/endpoints.fetchEndpoint`
    - `network/live.useLive`
    - `primitives/adaptive-bar.AdaptiveBar`
    - `primitives/css/badge.Badge`
    - `primitives/css/center.Center`
    - `primitives/css/cluster.Cluster`
    - `primitives/css/color-picker.ColorPicker`
    - `primitives/css/column.Column`
    - `primitives/css/coords.Placed`
    - `primitives/css/fill.Fill`
    - `primitives/css/inline.Inline`
    - `primitives/css/layer.layerClasses`
    - `primitives/css/line.Line`
    - `primitives/css/pin.Pin`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/slider.Slider`
    - `primitives/css/sticky.Sticky`
    - `primitives/dom/web-storage.defineStore`
    - `primitives/embed.isEmbeddedDocument`
    - `primitives/error-boundary.PluginErrorBoundary`
    - `primitives/icon-button.IconButton`
    - `primitives/loading.Loading`
    - `primitives/overlay/imperative-dialog/confirm.confirmDialog`
    - `primitives/overlay/popover.InlinePopover`
    - `primitives/overlay/portal-host.PortalHost`
    - `primitives/relative-time.RelativeTime`
    - `primitives/shortcuts.useSurfaceShortcuts`
    - `shell/toast.showToast`
    - `ui/icons.Icon`
  - Exports (types):
    - `CanvasAction`
    - `CanvasAddAction`
    - `CanvasFrame`
    - `CanvasFrameViewProps`
    - `CanvasLayout`
    - `CanvasSize`
    - `CanvasSourceEntry`
    - `CanvasState`
    - `CanvasZoom`
    - `FrameActionRow`
    - `FrameId`
    - `FrameLayout`
    - `FrameResolution`
    - `FrameSourceMeta`
    - `FrameSourceProps`
    - `PageExtent`
    - `PrototypeDetailContextValue`
    - `PrototypeFrame`
    - `RestoredCanvas`
    - `Room`
    - `SourceFrame`
    - `VersionStepperProps`
  - Exports (values):
    - `CanvasFrameView`
    - `canvasWith`
    - `decodeCanvas`
    - `documentOptions`
    - `encodeCanvas`
    - `frameA`
    - `FrameSource`
    - `layoutFrames`
    - `letterOf`
    - `OptionsPill`
    - `pageHeightOf`
    - `PrototypeCanvas`
    - `prototypeDetailPane`
    - `PrototypeDetailProvider`
    - `PrototypeDetailWrap`
    - `prototypeDocumentSrc`
    - `PrototypeFrameActions`
    - `prototypeFrames`
    - `PrototypeVersionActions`
    - `roomPerFrame`
    - `sameExtent`
    - `SizeChip`
    - `useFrameNames`
    - `useFramePicks`
    - `useFrameSrc`
    - `usePrototypeDetail`
    - `useWindowSize`
    - `VersionStepper`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/color-palette --primary-text`
    - `ui/tokens/color-palette --ring`
    - `ui/tokens/color-palette --warning`
    - `ui/tokens/density --space-lg`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/font-family --font-mono`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
  - Imported by:
    - `active-data/prototype`
    - `apps/prototypes/compare`
    - `apps/prototypes/copy-id`
    - `apps/prototypes/gallery`
    - `apps/prototypes/present`
    - `conversations/conversation-view/artifacts/prototype`
- Core:
  - Exports (types):
    - `CanvasFrameStatus`
    - `CanvasLayout`
  - Exports (values):
    - `CANVAS_CARD_ATTR`
    - `CANVAS_FRAME_ATTR`
    - `CANVAS_FRAME_KIND_ATTR`
    - `CANVAS_FRAME_STATUS_ATTR`
    - `CANVAS_LAYOUT_ATTR`
    - `canvasCardSelector`
    - `canvasFrameSelector`
    - `canvasLayoutSelector`
    - `PROTOTYPE_FRAME_KIND`

<!-- AUTOGENERATED:END -->

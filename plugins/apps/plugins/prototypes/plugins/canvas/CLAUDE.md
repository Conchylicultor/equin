# canvas

The prototype detail pane (`proto/:name`): one prototype shown as a
canvas of **frames** side by side — so a reader can put
two variants, two versions, or the mock and the real app next to each other
and look. Design: `research/2026-09-23-apps-prototypes-frame-canvas.md`
(mockup: prototype `proto-1790120832-wtfo`).

## The model

A frame shows one of two things:

- **the prototype** — one recorded version (or the live folder) under one set
  of option picks. Each prototype frame's header holds its own options chip
  and version stepper;
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

**Handing a canvas to the app** (`openCanvasInApp(name, state)`): a page that
cannot navigate in-app (Present's chromeless new-tab page) opens `proto/<id>`
by a document load ON a canvas it computed. The URL still names only the
prototype: the canvas goes through this tab's sessionStorage (a second store,
`prototypes.canvas-handoff`, keyed by prototype, one-minute TTL), and the next
detail pane that opens on that prototype with nothing saved takes it — saving
it as its own at once, so it is taken exactly once.

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

- **The add rail** (`AddFrameRail` — the very same rail every presentation
  shows) sits on the last frame's right border line (the swipe box's, swiped),
  revealed by hovering that frame, so it takes no room of its own (the board's
  side padding holds the half that overhangs):
  - **`+`** adds a copy of the LAST prototype frame — same version, same
    picks — ready to change its variant or version. (There is no per-frame
    Duplicate: `+` already is one, and Compare in a new frame copies a frame
    at another version.)
  - **Compare with <addLabel>** — one per frame source this prototype
    resolves ("Compare with Real app"), disabled while that source is already
    on the canvas. A source that does not resolve but offers a `launch` on its
    `unresolved` arm (the prototype declares no counterpart yet) keeps the
    button, which opens that agent launch popover instead of adding a frame.
    The canvas names no source. Adding one switches the canvas
    to Swipe (when that makes two frames) at Responsive size — a source frame
    is there to be compared against.
- **The options chip** in the frame's header box (`OptionsChip`: sliders
  glyph, the frame's name, a mono `+N` for the options the name leaves out, a
  chevron) opens "Options · <frame name>" under it: one row per declared
  option (84px label | value pills | link and spread icons at .4 until the row
  is hovered, the accent while on) — value pills for a choice; for a color, one
  swatch per suggestion and a trailing custom swatch (the color on screen,
  ringed when it is no suggestion) that opens the color picker in its own
  popover above the swatch. "Reset to defaults" sits in the header while the
  frame has a pick. (A presentation's tag is the very same box,
  `FrameShowsBox`, so its chip and stepper are these.) Options the page declares under a group
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
  The chip is app DOM over the frame, never inside the prototype's page — that
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

Each prototype frame's header has `‹ v14 latest ⌄ ›` (`version-stepper.tsx`;
a past version reads its age, `v12 6d ago`),
over `files`' per-prototype history resource. It moves only its own frame. The
stops are derived on every render from the history (`version-steps.ts`): the
recorded versions oldest first, the newest one being the live folder when it
is clean, plus a last "Live · unsaved" stop when the folder has changes no
version holds yet. The label opens the version list under it (`25 versions`,
a `DataView` with a hosted header — the count, its search behind the
hover-revealed options trigger, and the **This variant** chip — whose rows draw
themselves `v12 · request · when`, the current one scrolled into view on open,
and whose row actions are the `PrototypeVersionActions` slot — the
canvas ships **Compare in a new frame** (a copy of this frame, same picks,
showing that version; the stepper hands the frame to its row actions through
`VersionListFrameContext`) and "open the conversation that recorded it"), and on a past version
it ends with **Make vN the latest** (confirm, restore, back to live; the store
saves the current state first, so nothing is lost).

**This variant** (on by default) keeps the versions that can show what the
frame shows: those whose own page declares every option the frame picked, with
the picked value among its values (`declaresVariant`, `version-steps.ts` —
each version carries its own declared options). A version lacking one would
open at that option's default, a different variant. Offered only while the
frame has a pick: a frame on every default has nothing to filter by.

**The arrows never move**: the label has a floor wide enough for every form,
so stepping never slides › out from under the pointer (`canvas-version.ts`
asserts it). Known gap: the stepper sits after the options chip, and a version
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

One glass dock centred 12px above the canvas's bottom edge (`SizeDock` →
`SizeChip`, `size-chip.tsx`; fixed, not draggable — it is small and centred,
and the board's bottom pad leaves room for it): three device buttons
(**Responsive**, **This window**, **Phone** — the size in force lit, tooltips
above), a hairline, and the size button — `838 × 724` in mono, then the zoom
(`62%`) only while the frames are shown scaled below 100% — which opens the
**Size** popover above the dock (anchored to the dock, right-aligned, 10px up)
for all three. The popover is the mockup's own markup on primitives (a check
slot · glyph · name · dims list, then hairline bands), not a `ControlPanel`,
whose fixed row grid has no two-leading-cell form:

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
- **The Width slider** in the same popover (its `838px` readout above it) resizes EVERY frame (the size is
  canvas-wide), in 360–2560 px, snapping onto a preset it moves within 28 px
  of. Only a move toward a preset snaps, so an arrow key can step off one.
- **Zoom** is **Fit** (the default: the largest scale at which the whole frame
  is visible; at Responsive that is 100%) or a fixed scale from the 10–200%
  slider (with a detent at 100%); − / + step to the next multiple of 10%. The
  band's `100%` readout is a button, **Actual size**, that jumps to 100%. Zoom
  never changes what the page lays out at — only how big it is
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

## The board

The pane's header is a floating card over the canvas's top-left corner
(`PaneChrome header="card"`), so the canvas runs edge to edge under its chrome
on a fixed ground: a 28px hairline grid under a vignette (`CANVAS_GROUND`,
`components/canvas-ground.tsx`). The barrel exports it as `<CanvasGround>`, a
decorative fill the gallery passes as its pane's `ground`, so the gallery
sits on the same grid as the frames it opens.
`placeFrames` (pure, `internal/layout.ts`) puts every frame's SCREEN at an
absolute box: the room left by the chrome (`BOARD_PAD` — top 66 for the header
card, bottom 76 for the size dock, left 16, right 24 for the add rail's
overhang), `FRAME_HEAD` (34) above each screen for its header (drawn
`FRAME_HEAD_GAP` above it), `FRAME_GAP` (20) between frames; each frame
centred in its equal share. A frame bigger than its share (a zoom past Fit,
Whole page) widens every share instead, and the board grows past the viewport,
so the canvas scrolls. Each box and its screen glide to a new layout
(`GEOMETRY_MOTION`: left/top/width/height and the corners, .35s, none under
reduced motion); scrolling moves nothing. A screen is `rounded-xl`, a phone's
`rounded-4xl`, a tablet's `rounded-3xl`, ringed in the border hairline over
the deep `shadow-2xl`; `CanvasFrameView bare` (Present) draws it unframed.

## Swipe, selection, keyboard

With exactly two frames, a glass button sits in the gap between them —
**Swipe** (`LayoutToggle`, the add rail's family: `railButtonClass`, so every
canvas has it, header or not). Swipe paints the two frames in one box, B under A, A clipped at a
divider you drag; the divider carries the way back, a **Side by side** button
at its top. Adding or closing a frame while swiping goes back to side by side.

Clicking a frame selects it (it draws nothing; a new or changed frame becomes
selected). The selection is what the keys act on, registered once for the
canvas as surface-scoped plain keys (silent while a text field has focus):

- `←` / `→` select the previous / next frame (wrapping around) — a
  presentation's own `←` / `→` (flip the frame on show) outrank them while it
  is open;
- `[` / `]` step the selected frame's version;
- `0` toggles the zoom between 100% and Fit.

A selected frame shows its header actions; the others reveal them on hover.

A frame's header (`frame-header.tsx`, 26px, `FRAME_HEAD_GAP` above its
screen) is ONE box on the left (`frame-box.tsx`, `FrameShowsBox` — a
presentation's tag is the same component, floated) — the options chip | the
version stepper, on the card at 70% inside a 1px line (a prototype with no options: the stepper alone)
— or, for a source frame, a dashed tag naming it ("Real app", what it resolved
to as its tooltip); and the frame actions on the right, revealed on hover. The
box's 22px chips and 20px arrows are drawn by the `frameChipsTheme` sub-theme
(`internal/sub-themes.ts`; the Options rows and the version rows have theirs —
sizes the app's rungs do not draw).

It is as wide as its screen, so on a crowded canvas it runs out of room. It is
an `AdaptiveBar`: the actions that do not fit move behind a `⋯`, and the box
gives up room late, to its narrow form (no `+N`, no age, no chip chevron). The hover
reveal hides an action only while it sits in the row
(`hoverRevealTargetInAnchor`), so one in the `⋯` panel is visible there.

## The URL

The URL names only the prototype: `proto/<id>` (what the CLI prints). What is
on its canvas is remembered for the pane (above), so the URL and the saved
canvas can never disagree about it. The route lives in `shell/core/routes.ts`,
so the gallery can open this pane without either plugin depending on the
other.

## Extension points

- **`prototypeDetailPane.Actions`** — the pane header (the floating card:
  launcher, Back, the `Prototypes / <title>` trail, then these) IS the action
  bar. The canvas contributes nothing there (its controls are drawn on the
  canvas, so every canvas has them); `copy-id` the copy button; `gallery` the
  pin and Done toggles — each drawn as a `TitleActionButton` (compact, a step
  quieter, the accent while on, hidden under 900px). Order:
  `config/apps/prototypes/canvas/`.
- **`PrototypeFrameActions`** — a frame's header actions, handed
  `{ frame, meta }`. The canvas ships Keep only and Close; `present`
  adds Open in a new tab and Full screen.
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
`initialVersion` / `initialPicks`), `openCanvasInApp` (above),
`usePrototypeDetail`, `CanvasFrameView`
(the very same frame screen), `FrameShowsBox` (the frame header's box —
options chip | version stepper, or a source's name — which a presentation
floats as its tag, with its own controls around it), `SizeChip`,
`AddFrameRail` (its buttons' actions handed over by `extend`),
`layoutFrames` and `useFrameNames`.

## Driving it from outside: the DOM contract and e2e

Every frame's screen carries `data-canvas-frame="<letter>"`,
`data-canvas-frame-kind` (`prototype`, or the source's id — the canvas
publishes the id it was given) and `data-canvas-frame-status` (`loading` /
`unresolved` / `found`). Side by side, each frame's card (header, screen)
carries `data-canvas-card="<letter>"`; the canvas root carries
`data-canvas-layout` (`side` / `swipe`, as drawn). Swiped (what adding a
source frame does) there are no cards, so a flow needing a card or one screen
alone calls the driver's `setLayout(page, "side")` first (it presses the
layout toggle, named by `layoutToggleLabel`). The
names and selectors live in `core/`, the one spelling the canvas and an `e2e/`
script both read.

`e2e/index.ts` holds the shared flows (open a canvas, add a frame, add a
source frame by its add label (the rail's labels are `ADD_FRAME_LABEL` /
`compareWithLabel` in `core/`), find a frame, read back
the size, version and picks its document was opened with — off the iframe's
`src` and box, so assertions are about what is on screen). The scripts, all
manual, default to the first prototype declaring an option with 3+ values and a
`mocks` counterpart (`--name` to choose):

- `canvas-frames.ts` — `+` copies the last frame, B's picks are its own,
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

- Description: The prototype detail pane as a canvas of frames: the prototype (frame A reads and writes the shared option picks, every other frame holds its own), each with its own options chip and version stepper in its header, beside frames from contributed sources (FrameSource — the real app, from compare); one canvas-wide size & zoom chip (Responsive / device presets / custom, Fit or 10–200%, Whole page), a Width slider that resizes every frame and snaps to the presets, side-by-side or swipe, keep-only with Undo, link and spread across frames; the whole canvas is remembered per pane for the browser tab's session, so a reload reopens it as it was left while a new pane starts fresh.
- Web:
  - Slots:
    - `prototypeDetailPane.Actions`
    - `PrototypeFrameActions`
    - `FrameSource`
    - `PrototypeDetailWrap`
    - `PrototypeVersionActions`
  - Slot contributors:
    - `prototypeDetailPane.Actions` ← `apps.prototypes.copy-id`
    - `prototypeDetailPane.Actions` ← `apps.prototypes.gallery`
    - `prototypeDetailPane.Actions` ← `primitives.pane`
    - `PrototypeFrameActions` ← `apps.prototypes.canvas`
    - `PrototypeFrameActions` ← `apps.prototypes.present`
    - `FrameSource` ← `apps.prototypes.compare`
    - `PrototypeDetailWrap` ← `apps.prototypes.present`
    - `PrototypeVersionActions` ← `apps.prototypes.canvas`
  - Contributes:
    - `Pane.Register` "prototypes-detail"
    - `Hints.Hint` "prototypes.variants"
    - `ThemeEngine.SubTheme` "Prototype frame chips"
    - `ThemeEngine.SubTheme` "Prototype option rows"
    - `ThemeEngine.SubTheme` "Prototype version rows"
    - `PrototypeFrameActions` "keep-only" → `KeepOnlyFrameAction`
    - `PrototypeFrameActions` "close" → `CloseFrameAction`
    - `PrototypeVersionActions` "compare" → `CompareVersionAction`
    - `PrototypeVersionActions` "open-conversation" → `OpenVersionConversation`
  - Uses: 86 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×9
    - `primitives/data-view` ×6
    - `primitives/collapsible` ×5
    - `hints` ×3
    - `primitives/hover-reveal` ×3
    - `primitives/persistent-draft` ×3
    - `infra/endpoints` ×2
    - `primitives/action-presentation` ×2
    - `primitives/css/spacing` ×2
    - `primitives/dom/auto-scroll` ×2
    - `primitives/dom/element-size` ×2
    - `primitives/icon-button` ×2
    - `primitives/latest-ref` ×2
    - `primitives/live-state` ×2
    - `primitives/optimistic-mutation` ×2
    - `primitives/pane` ×2
    - `primitives/slot-render` ×2
    - `apps-core/tabs.appLinkProps`
    - `network/live.useLive`
    - `primitives/adaptive-bar.AdaptiveBar`
    - `primitives/css/badge.Badge`
    - `primitives/css/center.Center`
    - `primitives/css/cluster.Cluster`
    - `primitives/css/color-picker.ColorPicker`
    - `primitives/css/coords.Placed`
    - `primitives/css/fill.Fill`
    - `primitives/css/layer.layerClasses`
    - `primitives/css/line.Line`
    - `primitives/css/pin.Pin`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/row.Row`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/slider.Slider`
    - `primitives/css/surface.Surface`
    - `primitives/css/switch.SwitchIndicator`
    - `primitives/css/text.Text`
    - `primitives/css/theme-boundary.Theme`
    - `primitives/css/yield.yieldClass`
    - `primitives/dom/scroll-reveal.useRevealOnActive`
    - `primitives/dom/web-storage.defineStore`
    - `primitives/embed.isEmbeddedDocument`
    - `primitives/error-boundary.PluginErrorBoundary`
    - `primitives/launch.LaunchAgentPopover`
    - `primitives/loading.Loading`
    - `primitives/overlay/imperative-dialog/confirm.confirmDialog`
    - `primitives/overlay/popover.InlinePopover`
    - `primitives/overlay/portal-host.PortalHost`
    - `primitives/relative-time.RelativeTime`
    - `primitives/shortcuts.useSurfaceShortcuts`
    - `shell/toast.showToast`
    - `ui/icons.Icon`
    - `ui/theme-engine.ThemeEngine`
  - Exports (types):
    - `AddFrameHandlers`
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
    - `FrameLaunch`
    - `FrameLayout`
    - `FrameResolution`
    - `FrameSourceMeta`
    - `FrameSourceProps`
    - `PageExtent`
    - `PrototypeDetailContextValue`
    - `PrototypeFrame`
    - `Room`
    - `SourceFrame`
  - Exports (values):
    - `AddFrameRail`
    - `CanvasFrameView`
    - `CanvasGround`
    - `canvasWith`
    - `documentOptions`
    - `frameA`
    - `FrameShowsBox`
    - `FrameSource`
    - `layoutFrames`
    - `letterOf`
    - `openCanvasInApp`
    - `pageHeightOf`
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
    - `TitleActionButton`
    - `useFrameNames`
    - `useFramePicks`
    - `useFrameSrc`
    - `usePrototypeDetail`
    - `useWindowSize`
- Core:
  - Uses:
    - `hints.defineHint`
    - `hints.defineHintAnchor`
  - Exports (types):
    - `CanvasFrameStatus`
    - `CanvasLayout`
  - Exports (values):
    - `ADD_FRAME_LABEL`
    - `CANVAS_CARD_ATTR`
    - `CANVAS_FRAME_ATTR`
    - `CANVAS_FRAME_KIND_ATTR`
    - `CANVAS_FRAME_STATUS_ATTR`
    - `CANVAS_LAYOUT_ATTR`
    - `canvasCardSelector`
    - `canvasFrameSelector`
    - `canvasLayoutSelector`
    - `compareWithLabel`
    - `layoutToggleLabel`
    - `optionsChipAnchor`
    - `PROTOTYPE_FRAME_KIND`
    - `variantsHint`
- Cross-plugin:
  - Uses tokens: 37 vars — full list in [REFERENCE.md](./REFERENCE.md)
    - `ui/tokens/color-palette` ×12
    - `ui/tokens/type-scale` ×12
    - `ui/tokens/density` ×6
    - `ui/tokens/shape` ×4
    - `ui/tokens/shadow` ×2
    - `ui/tokens/font-family --font-mono`
  - Imported by:
    - `active-data/prototype`
    - `apps/prototypes/compare`
    - `apps/prototypes/copy-id`
    - `apps/prototypes/gallery`
    - `apps/prototypes/present`
    - `conversations/conversation-view/artifacts/prototype`

<!-- AUTOGENERATED:END -->

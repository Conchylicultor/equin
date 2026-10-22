# present

**Present** shows one canvas frame with none of the app around it. It
contributes two frame actions (`PrototypeFrameActions`), so every frame of the
prototype canvas gets both, and the canvas knows nothing about them:

- **Open in a new tab** (`OpenNewTabAction`) — opens the frame's present page
  (below) chromeless (`embedUrl(…, "chromeless")`, so no tab bar, rail or
  action bar) in a new browser tab, at the Responsive size
  (`present/<id>/<version>/responsive`) whatever size the canvas is at — at Fit
  that is the page laid out at the tab's own width, filling it. A source frame
  (the real app) opens its own `href`, which already is that, and the button is
  disabled when it has none. The href comes from `BrowserTabOpener`
  (`components/frame-link.tsx`), opened as a `NewTabButton`.
- **Full screen** (`F`, `FullScreenAction`) — a `<ViewportOverlay layer="max">`
  over the whole page, handed to the browser's Fullscreen API. Escape exits
  fullscreen (the browser handles it), and the resulting `fullscreenchange`
  closes the overlay, so one key still leaves.

**`F` presents the selected frame** in full screen. Only the selected frame's
button registers the key (a surface-scoped shortcut, silent in text fields),
and it stands down while a presentation is open. Presenting selects the frame
first, so the button holding `F` is always the one presenting.

## While presenting

The frame is drawn by the canvas's own `CanvasFrameView` (`bare`: no corners,
ring or drop — it is the whole view), sized by the canvas's
size, zoom and Whole page — but computed for the room the presentation has. So
"Phone at Fit" is a phone filling the screen, and "Responsive at Fit" is the
page laid out at the screen's own width. When the frame is bigger than the room
(a zoom past Fit, a tall whole page) it scrolls.

Hovering shows the chrome (`PresentStage`), each piece on the canvas's
floating glass (`<Surface level="float">`):

- top-centre, the frame's **tag**: the canvas frame header's own box
  (`FrameShowsBox` — the options chip | the version stepper, or a source
  frame's name), floated, so the two can never drift apart; then "2 of 3 ‹ ›"
  when the canvas has more than one frame — ‹ › flip to the previous / next
  frame, like the arrow keys. In an overlay, the version list's Compare adds
  the frame and leaves, like `+`;
- **Exit `Esc`** — top-right;
- the canvas's **size & zoom chip**, bottom right. Changing it changes the
  canvas too: there is one size for the whole canvas.

**Every piece of chrome can be dragged** off what it covers in the frame
(`Movable`, `primitives/dom/movable`): grab its surface, or press one of its
buttons and pull — a plain press is still a click. It stays inside the box, and
a double-click on its surface sends it home. Positions last as long as the
presentation (flipping frames keeps them); they are not saved.

**Resting the pointer hides the chrome again** (`PresentBox`,
`internal/use-pointer-idle.ts`): after 0.8 s with no pointer move, press, wheel
or key over the presentation it fades out, so what it covers can be seen —
the video-player rule. The frame is an iframe, whose events never reach our
document, so every same-origin document loaded under the box is watched too
(attached on its `load`, captured at the box). It stays up while the pointer
rests on the chrome itself, while a chrome control holds keyboard focus, and
while a popup opened from it (the version list, the size menu) is showing.

**← / → flip through the canvas's frames in place** (surface-scoped
shortcuts, at a priority over the canvas's own ← / →, which select a frame on
the canvas still mounted underneath). Leaving selects the frame last on show, so the canvas comes back on
it.

**On the right edge, `+` and Compare** — the canvas's own add rail
(`AddFrameRail`, the one the canvas pane shows; `ExtendActions` hands it what
each button does): `+` adds a frame beside this one, and there is one
**Compare with <addLabel>** per frame source this prototype resolves (the real
app, swiped over it — `addSource` switches to Swipe). Comparing happens on the
canvas in the app, never in a presentation: the overlay dispatches the action
to the live canvas — the pane's own — and leaves, so the pane shows the frame
it added (selected by the reducer). The new-tab page opens the app's canvas
instead (below).

**Our own Escape handler is gated on `useSurfaceFocused()`.** Tabs are
keep-alive — a background tab is still mounted, and under the floating
placement still on screen — so an ungated `window` keydown would close a
presentation the user is not looking at.

**The overlay's stage box is a `PortalHost`**: every popup opened inside the
presentation (the version list, the size menu, the options popover, a tooltip)
is drawn inside the box instead of under `body`. Under the Fullscreen API only
the fullscreened subtree is painted, and the overlay sits above the popup
layer, so without it those popups would be invisible.

**The open presentation is held above the frames** (`PresentationHost`, a
`PrototypeDetailWrap` contribution — inside every `PrototypeDetailProvider`):
the Full screen button only asks for it (`usePresentation`). The button lives
in its frame's header, which a layout change remounts (`+` leaving Swipe,
Compare entering it), and that must not close the presentation that made the
change. Each request remounts the overlay (keyed by a counter), so each one
requests full screen afresh.

## The present page

`present/<id>/<version>/<size>[/<picks>]` (`prototypePresentPane`, a root route of
the Prototypes app, so opened alone it is the only column and fills the tab):

- `version` is a recorded version's sha, or `live` for the live folder. It is
  required rather than optional because a route may have only one optional
  part, and it must be the last — `picks` needs that place.
- `size` is `declared` (the prototype's own `<meta name="prototype-viewport">`)
  or a size word (`responsive`, `window`, `phone`, …), handed to the canvas as
  `initialSize`. Required for the same reason as `version`.
- `picks` is the frame's own picks, `a=b,c=d` (each name and value escaped on
  its own, `internal/present-link.ts`). Frame A reads the shared picks record,
  so its link carries none, and the page then reads the shared record too.
  Any other frame's link carries its own variant.

The page mounts a one-frame canvas (`PrototypeDetailProvider` with
`initialVersion` and `initialPicks`) and draws the same `PresentStage`, with
page chrome of its own instead of the overlays' Exit:

- **Exit** (an icon at the start of the tag's pill, top-centre) goes back to the
  prototype's canvas (`proto/<id>`) in the full app — a document load, since
  this document was opened chromeless and stays so (`embedMode` is read once);
- the right edge's `+` / Compare each compute the canvas the action leads to
  (`canvasWith`, the reducer without its effects) and open the prototype's
  canvas in the full app on it (`openCanvasInApp` from `canvas`: a document
  load of `proto/<id>` handing the canvas over through this tab's
  sessionStorage). Only a page reading the shared picks (frame A's link)
  offers them: one carrying a variant of its own would, as frame A of a
  canvas, have to write that variant to the shared record, so they are
  disabled there.

The routes live in `internal/routes.ts`, apart from the panes.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Two frame actions on every prototype canvas frame: Open in a new tab (the frame's chromeless present page at the Responsive size, filling the tab at its own width; a source frame opens its own href) and Full screen (F, which presents the selected frame; the browser's Fullscreen API). While presenting, hovering shows the frame's tag (the canvas frame header's own box: options chip | version stepper) and 'i of n', Exit and the size & zoom chip, on the right edge + (add a frame) and Compare with each resolved frame source (the real app, swiped) — both adding the frame and leaving to the prototype's canvas in the app — and the left and right arrow keys flip through the canvas's frames. The new tab is present/<id>/<sha|live>/<declared|size word>/<picks?>, a one-frame page carrying the frame's version and own picks, with an Exit icon back to the prototype's canvas; its + / Compare open the app's canvas on the frame plus the new one.
- Web:
  - Slots: `prototypes-present.actions`
  - Slot contributors: `prototypes-present.actions` ← `primitives.pane`
  - Contributes:
    - `Pane.Register` "prototypes-present"
    - `PrototypeDetailWrap` → `PresentationHost`
    - `PrototypeFrameActions` "open-new-tab" → `OpenNewTabAction`
    - `PrototypeFrameActions` "full-screen" → `FullScreenAction`
  - Uses: 53 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps/prototypes/canvas` ×25
    - `primitives/css/ui-kit` ×3
    - `primitives/hover-reveal` ×2
    - `primitives/latest-ref` ×2
    - `primitives/pane` ×2
    - `apps-core/tabs.useSurfaceFocused`
    - `network/live.useLive`
    - `primitives/css/pin.Pin`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/spacing.Stack`
    - `primitives/css/surface.Surface`
    - `primitives/css/text.Text`
    - `primitives/css/viewport-overlay.ViewportOverlay`
    - `primitives/dom/element-size.useElementSize`
    - `primitives/dom/movable.Movable`
    - `primitives/embed.embedUrl`
    - `primitives/icon-button.IconButton`
    - `primitives/link-gesture/new-tab.NewTabButton`
    - `primitives/live-state.matchResource`
    - `primitives/loading.Loading`
    - `primitives/overlay/popup-open.PopupOpenScope`
    - `primitives/overlay/portal-host.PortalHost`
    - `primitives/overlay/tooltip.Kbd`
    - `primitives/shortcuts.useSurfaceShortcuts`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --background`
    - `ui/tokens/density --space-2xs`
    - `ui/tokens/density --space-lg`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shape --radius-popover`

<!-- AUTOGENERATED:END -->

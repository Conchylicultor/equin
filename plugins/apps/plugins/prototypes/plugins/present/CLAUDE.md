# present

**Present** shows one canvas frame with none of the app around it. It is a
frame action (`PrototypeFrameActions`), so every frame of the prototype canvas
gets its own Present button, and the canvas knows nothing about it.

The menu, headed "Present B", has three rows, ordered by how much they cover:

- **In this app tab** — a `<SurfaceOverlay>` filling the tab's surface. The
  Singularity tab bar and app rail stay visible and clickable, so the user can
  leave a frame presented and keep working in other tabs. Its trailing icon,
  **Open in a new app tab**, opens the frame's present page in a new app tab
  (`navigate(…, { newTab: true })` from `apps-core/tabs`).
- **In this browser tab** — a `<ViewportOverlay layer="max">`: the whole page,
  app chrome included. Its trailing icon, **Open in a new browser tab**, opens
  the frame's present page chromeless (`embedUrl(…, "chromeless")`, so no tab
  bar, rail or action bar). For a source frame (the real app) it opens the
  source's own `href` instead, and is disabled when the source has none. The
  new-app-tab icon is disabled on a source frame: the present page shows only
  prototype frames.
- **Full screen** (`F`) — the viewport overlay, also handed to the browser's
  Fullscreen API. Escape exits fullscreen (the browser handles it), and the
  resulting `fullscreenchange` closes the overlay, so one key still leaves.

**Open responsive in a new tab** is a second frame action of its own, beside
the menu (`OpenResponsiveAction`): one click opens the new-browser-tab page at
the Responsive size (`present/<id>/<version>/responsive`) whatever size the
canvas is at — at Fit that is the page laid out at the tab's own width, filling
it. A source frame opens its own `href`, which already is that, and the button
is disabled when it has none. Both it and the menu's new-browser-tab icon go
through `BrowserTabOpener` (`components/frame-link.tsx`).

**`F` presents the selected frame** in full screen. Only the selected frame's
menu registers the key (a surface-scoped shortcut, silent in text fields), and
it stands down while that menu's presentation is open. Presenting selects the
frame first, so the menu holding `F` is always the one presenting.

## While presenting

The frame is drawn by the canvas's own `CanvasFrameView`, sized by the canvas's
size, zoom and Whole page — but computed for the room the presentation has. So
"Phone at Fit" is a phone filling the screen, and "Responsive at Fit" is the
page laid out at the screen's own width. When the frame is bigger than the room
(a zoom past Fit, a tall whole page) it scrolls.

Hovering shows the chrome (`PresentStage`):

- top-left, the frame's **tag**: its letter, its name, its version stepper (or a
  source frame's tag), and "2 of 3 · ← →" when the canvas has more than one
  frame;
- **Exit `Esc`** — top-right, except in the app-tab placement, where it sits
  beside the tag: the app's floating action bar is portaled above us at the
  top-right, and would land on it;
- the frame's **options pill**, bottom centre;
- the canvas's **size & zoom chip**, bottom right. Changing it changes the
  canvas too: there is one size for the whole canvas.

**Resting the pointer hides the chrome again** (`PresentBox`,
`internal/use-pointer-idle.ts`): after 0.8 s with no pointer move, press, wheel
or key over the presentation it fades out, so what it covers can be seen —
the video-player rule. The frame is an iframe, whose events never reach our
document, so every same-origin document loaded under the box is watched too
(attached on its `load`, captured at the box). It stays up while the pointer
rests on the chrome itself, while a chrome control holds keyboard focus, and
while a popup opened from it (the version list, the size menu) is showing.

**← / → flip through the canvas's frames in place** (surface-scoped
shortcuts). Leaving selects the frame last on show, so the canvas comes back on
it.

**Escape is gated on `useSurfaceFocused()`.** Tabs are keep-alive — a background
tab is still mounted, and under the floating placement still on screen — so an
ungated `window` keydown would close a presentation the user is not looking at.

**The overlay's stage box is a `PortalHost`**: every popup opened inside the
presentation (the version list, the size menu, the options popover, a tooltip)
is drawn inside the box instead of under `body`. Under the Fullscreen API only
the fullscreened subtree is painted, and a viewport presentation sits above the
popup layer, so without it those popups would be invisible.

The overlay is rendered with `key={placement}`, so switching destination is an
explicit remount rather than a portal-container swap React would reconcile into
a half-move.

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
`initialVersion` and `initialPicks`) and draws the same `PresentStage`, minus
Exit: closing the tab is how you leave.

## The whole canvas in a new tab

**Open the canvas in a new tab** is a header action of the canvas pane
(`prototypeDetailPane.Actions`, `components/open-canvas-action.tsx`): it opens
the canvas exactly as it is — every frame with its version and own picks, the
size, zoom, Whole page, layout and selection — chromeless in a new browser tab,
so the frames get the whole screen to compare options in.

The page is `present-canvas/<id>/<canvas>` (`prototypePresentCanvasPane`, a
root route), where `canvas` is the canvas's own url encoding (`encodeCanvas` /
`decodeCanvas` from `canvas`, base64url of the same JSON the pane saves, held
to the same rules). Frame A carries `"shared"`, so the page reads the shared
picks record like the pane. It mounts `PrototypeDetailProvider` with
`initialCanvas` and draws `PrototypeCanvas` — the pane's own body, minus the
pane header — so it stays a working canvas (options pills, version steppers,
frame actions, the size & zoom chip). Nothing is remembered there (it is an
embedded document): a reload reopens the canvas the link carries.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Present one canvas frame without the app around it: a per-frame Present menu (a frame action) with In this app tab (the tab bar stays) plus a new-app-tab icon, In this browser tab plus a new-browser-tab icon, and Full screen (F, which presents the selected frame); beside it, an Open responsive in a new tab button (the chromeless present page at the Responsive size, filling the tab at its own width). While presenting, hovering shows the frame's tag with its version stepper and 'i of n', Exit, the options pill and the size & zoom chip, and the left and right arrow keys flip through the canvas's frames. A new tab opens present/<id>/<sha|live>/<declared|size word>/<picks?>, a one-frame page carrying the frame's version and own picks. In the canvas header, Open the canvas in a new tab opens the whole canvas (frames, versions, picks, size, zoom, layout, encoded in present-canvas/<id>/<canvas>) chromeless in a new browser tab, so the frames get the whole screen to compare.
- Web:
  - Slots:
    - `prototypes-present.actions`
    - `prototypes-present-canvas.actions`
  - Slot contributors:
    - `prototypes-present.actions` ← `primitives.pane`
    - `prototypes-present-canvas.actions` ← `primitives.pane`
  - Contributes:
    - `Pane.Register` "prototypes-present"
    - `Pane.Register` "prototypes-present-canvas"
    - `prototypeDetailPane.Actions` "open-canvas" → `OpenCanvasAction`
    - `PrototypeFrameActions` "present" → `PresentMenu`
    - `PrototypeFrameActions` "open-responsive" → `OpenResponsiveAction`
  - Uses: 60 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps/prototypes/canvas` ×25
    - `primitives/css/ui-kit` ×8
    - `apps-core/tabs` ×2
    - `primitives/hover-reveal` ×2
    - `primitives/latest-ref` ×2
    - `primitives/pane` ×2
    - `network/live.useLive`
    - `primitives/css/badge.Badge`
    - `primitives/css/fill.fillClasses`
    - `primitives/css/pin.Pin`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/viewport-overlay.ViewportOverlay`
    - `primitives/dom/element-size.useElementSize`
    - `primitives/embed.embedUrl`
    - `primitives/icon-button.IconButton`
    - `primitives/live-state.matchResource`
    - `primitives/loading.Loading`
    - `primitives/overlay/popup-open.PopupOpenScope`
    - `primitives/overlay/portal-host.PortalHost`
    - `primitives/overlay/surface-overlay.SurfaceOverlay`
    - `primitives/overlay/tooltip.Kbd`
    - `primitives/shortcuts.useSurfaceShortcuts`
    - `ui/icons.Icon`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/density --space-2xs`
    - `ui/tokens/density --space-lg`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shadow --shadow-md`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`

<!-- AUTOGENERATED:END -->

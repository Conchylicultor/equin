# media-player

`<MediaPlayer kind src label autoPlay? poster? onError? className? />` — a themed
video / audio player in place of the browser's native `controls`, which
cannot be themed, cannot grow a control (a fine speed, loop in the bar) and
float an unthemable picture in picture. The design is the prototype
`proto-1793924689-zwfacl` (its `slim` size and `clear` glass), implemented
measure for measure, animations included. Plan:
[`research/2026-11-06-primitives-media-player.md`](../../../../research/2026-11-06-primitives-media-player.md).

```tsx
<MediaPlayer
  key={attempt}            // the caller's Retry: a fresh element opens the file again
  kind="video"
  src={src}
  label={name}
  autoPlay
  onError={(error) => setFailed(describe(error))}  // the caller owns the error UI
  className="max-h-full"
/>
```

## What it draws

- **Video**: the picture (the `poster` until the first play, if given — else
  the first frame), and over it a **floating glass pill** — play ·
  volume · current time · seek bar · time left (click: the total) · settings ·
  full screen. The controls fade after 2 s once the pointer rests, playing
  or paused (never while a panel is open or the seek bar is dragged; the
  cursor hides with them). A big play button until the first play, and a **centre
  flash** for what a key or click just did (play, pause, skip, volume, speed,
  loop).
- **Scrub preview** (video): hovering the seek bar shows the frame at the
  time under the pointer above the time bubble, YouTube style — a second,
  muted `<video>` on the same file (mounted on the first hover only), seeked
  one seek at a time to the latest target (`internal/preview-seeker.ts`),
  sized a quarter of the player (`previewSize`), kept inside the player.
- **Audio**: the same pill as a static bar in the flow — no idle fade, no
  full screen, no picture in picture; settings = speed + loop. (A small
  extrapolation of the prototype, which designs video only.)
- **Volume capsule**: hovering (or focusing) the speaker opens a vertical
  `Slider` (`css/slider`'s `orientation="vertical"`) in a glass capsule
  centred over it, 6px above the pill, an invisible bridge over the gap.
  Wheel, drag and arrow keys; no number.
- **Settings panel**: the speed readout and reset, the **speed dial** (a
  ruler under a fixed needle: 0.25–3× in 0.05 steps, drag / wheel / click /
  ← → / Home End, settling onto the step), preset chips 0.5 / 1 / 1.5 / 2,
  Loop (R) and Picture in picture (P). The gear turns while it is open and
  wears the speed as a badge when it is not 1×.

## Touch

On a touch-first screen (`(hover: none) and (pointer: coarse)`, read live
through `dom/render-mode`'s `useMediaQuery`) a video draws the touch
controls instead of the pill — the prototype `proto-1794361798-f9dak8`,
YouTube's model (`components/touch-controls.tsx`):

- A **tap on the picture shows or hides the controls**; it never plays or
  pauses. Playing, they hide after `TOUCH_HIDE_MS` (3 s); paused, they stay.
- The **centre** holds −10 s · play/pause (replay at the end) · +10 s, small
  float-glass circles (32 / 48 px inline, 40 / 60 px in full screen).
- A **double-tap on a side** (left / right ~38 %) seeks 10 s, with a shaded
  half-moon counting the seconds; each further tap on that side within
  `SEEK_RUN_MS` seeks 10 s more. The tap grammar is pure (`internal/taps.ts`).
- **Top**: the title (full screen only), mute, settings. **Bottom**: the time
  (tap: what is left) and **full screen alone in its corner**, away from the
  centre.
- **The bar is flush on the bottom edge**, there whether the controls show or
  not; only its track is clipped to the player's corners (its ends follow the
  curve), the thumb sits outside the clip. A drag seeks live with the time in
  a bubble. In full screen it rises off the edge, inset, shown with the
  controls.
- **Settings** open as a sheet from the bottom of the screen, over a scrim
  (the inline player is too short to hold the panel): the same panel at
  `--k: 1`, without key caps.

Audio keeps its bar on touch. Where the browser cannot put an element in full
screen (`document.fullscreenEnabled` false — an iPhone), Full screen makes the
player **fill the window** (`data-filling`) instead, on any device.

## Keyboard

Space / K play · ← → 5 s of watching (media time × the speed: 1.25 s at
0.25×, 10 s at 2×) · ↑ ↓ volume · M mute · F full screen · P picture
in picture · R loop · `<` `>` speed ±0.25 · 0–9 jump · Esc closes the
settings. The table is data (`internal/keymap.ts`). On the page every key is
a surface shortcut (`useSurfaceShortcuts`, Space through
`usePlayPauseShortcut`) — never a raw listener — gated by **whose key it
is**: every key landing inside a player is that player's; from elsewhere on
the surface only Space reaches a player (the playing one, else the first), so
a page with a video block keeps its own arrows and letters. The focused seek
bar takes a slider's keys (← → ↑ ↓ the same speed-scaled 5 s, Page Up/Down a tenth, Home/End), and
the volume capsule — drawn outside the pill so its blur sees the picture —
sits right after the speaker in the tab order and closes when focus leaves
both. Space on one of the player's own buttons the user reached by keyboard is
that button's (it activates on Space itself), so it never toggles twice; on
a button merely focused by a click (Full screen, say — ui-kit's
`isPointerModality`) Space still plays / pauses.
Focus rings show only after keyboard input (`:focus-visible`).

## Theming

The controls are dark glass with white glyphs whatever the app's theme (the
video convention): a **fixed theme**, `media-player` (`internal/theme.ts`),
so the tooltips and panels opened from it wear it too. Its pieces are the
surface roles: the pill, capsule, flash and big play button are `float`
glass (the `material` group's float fill / backdrop / border,
`shadow-float`), the settings panel the denser `overlay` glass (popover fill
and backdrop). A hovered or open button is the float surface's hover
(`accent`), the accent — played part, needle, picked chip, Loop on — is
`primary`. Two sub-themes: the settings panel's `fontScale` (it is drawn at
the pill's scale, `SLIM.k`), and the volume slider's white fill and track.
`media-player.css` holds the prototype's geometry and motion; every colour
there is a token or a tint of the foreground.

## Full screen and picture in picture

Full screen puts the player's own root in full screen, so the controls come
along; a `PortalHost` inside the root keeps tooltips drawn there.

Picture in picture is a **Document Picture-in-Picture** window holding the
whole player. `MediaPlayer` renders the player through `createPortal` into a
host element it owns, and moves that host into the window: the same
`<video>` keeps playing, and every React listener comes along (React listens
on a portal's container). The window is dressed as the page — stylesheets,
the `<html>` attributes the theme paints through, and the inline icon
sprites (`<use href="#…">` draws nothing without them) — and kept in sync
by a mutation observer while open. The page keeps a placeholder with **Bring
back**. In the window the page's shortcut listener hears nothing, so the
player answers the same key table itself. Where the browser has no such
window, or refuses it (inside a frame Chrome answers "only allowed from a
top-level browsing context" — a `DOMException`), the video's own picture in
picture is used, with a `console.warn` naming why; any other error throws.

## Sizes and glass

Only `slim` and `clear` ship. Their numbers are named constants
(`internal/geometry.ts`, `internal/theme.ts`), with the prototype's
`regular` / `slimmer` sizes and `frosted` / `dark` glass written beside them,
so a size or glass option later is one set switched as a whole.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Themed video / audio player in place of the browser's native controls: a floating glass control pill (play, volume, time, seek, settings, full screen) that fades while playing, a vertical volume capsule, a settings panel with a fine speed dial (0.25–3×), presets, loop and picture in picture (a Document Picture-in-Picture window holding the whole player, falling back to the video's own), centre feedback and the YouTube-style keyboard. Audio draws the same controls as a static bar.
- Web:
  - Contributes:
    - `ThemeEngine.FixedTheme` "Media player controls"
    - `ThemeEngine.SubTheme` "Media player settings panel"
    - `ThemeEngine.SubTheme` "Media player volume"
  - Uses: 23 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×6
    - `primitives/shortcuts` ×3
    - `primitives/latest-ref` ×2
    - `primitives/css/slider.Slider`
    - `primitives/css/switch.SwitchIndicator`
    - `primitives/css/text.Text`
    - `primitives/css/theme-boundary.Theme`
    - `primitives/dom/render-mode.useMediaQuery`
    - `primitives/dom/scroll-reveal.focusElement`
    - `primitives/icon-button.IconButton`
    - `primitives/overlay/portal-host.PortalHost`
    - `primitives/overlay/tooltip.Kbd`
    - `primitives/scope/surface-id.useSurfaceTabId`
    - `ui/icons.Icon`
    - `ui/theme-engine.ThemeEngine`
  - Exports (types): `MediaPlayerProps`
  - Exports (values): `MediaPlayer`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --card`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --popover`
    - `ui/tokens/color-palette --popover-hover`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/color-palette --primary-foreground`
    - `ui/tokens/shadow --shadow-float`
    - `ui/tokens/shadow --shadow-lg`
    - `ui/tokens/shadow --shadow-popover`
    - `ui/tokens/shape --radius`
    - `ui/tokens/type-scale --font-scale`
    - `ui/tokens/type-scale --font-size-2xs`
    - `ui/tokens/type-scale --font-size-tag-compact`
    - `ui/tokens/type-scale --font-weight-bold`
    - `ui/tokens/type-scale --line-height-2xs`
    - `ui/tokens/type-scale --line-height-tag-compact`
  - Imported by:
    - `apps/website/landing/hero`
    - `page/audio`
    - `page/video`
    - `primitives/file-viewer/media`

<!-- AUTOGENERATED:END -->

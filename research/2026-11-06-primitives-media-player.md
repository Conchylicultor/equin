# Media player primitive

## Context

All three user-facing players in the app are the browser's native `<video controls>` / `<audio controls>`:
`primitives/file-viewer/media` (`media-view.tsx`), `page/video` and `page/audio` blocks. We cannot theme
them, cannot add controls (fine speed, loop in the bar), and Chrome's picture-in-picture is unthemable.

The design was iterated in prototype **proto-1793924689-zwfacl**
(`~/.equin/apps/prototypes/proto-1793924689-zwfacl/index.html`, final state v9+). It is the
spec: implementation is **pixel-perfect, animations included**. Every implementing agent reads that file
first and keeps it open.

## What the prototype specifies (summary — the file is authoritative)

- **Floating pill**, centred, `bottom: 14px`, `width: min(760px, 100% - 28px)`, fully rounded, frosted glass.
  Row: play · volume · current time · seek bar (flex) · remaining time (click toggles remaining/total) ·
  settings · fullscreen.
- **Seek bar**: 4px track → 6px on hover; buffered / hovered / played (accent) layers; white thumb scales in
  on hover; time bubble above the cursor; pointer-capture drag pauses then resumes.
- **Volume**: hovering the speaker opens a vertical capsule centred above it, `--gap` (6px) above the pill,
  with an invisible bridge over the gap; capsule width = button + 4px; thumb centre travels between the
  centres of the capsule's round ends, track caps centred there too. Wheel / drag / arrow keys. No number.
  Entrance: rise + scale from the button (`.34s cubic-bezier(.2,.9,.25,1)`).
- **Settings panel** (gear rotates 60° when open; badge shows the speed when ≠ 1×): speed readout + reset,
  **ruler dial** (0.25–3×, 0.05 steps, drag / wheel / click / ←→, settles to step; majors at 0.5 with
  labels, mids at 0.25; accent needle; edge fade mask), preset chips 0.5/1/1.5/2, Loop switch (R),
  Picture in picture item (P). Whole panel scales with size (factor = pill height / 48).
- **Sizes**: regular / slim / slimmer (pill 48 / 42 / 36). **Ship `slim`** as the one size (the prototype
  default); keep the values as named constants so a size knob can come later.
- **Glass**: ship the `clear` recipe (light tint over strong blur, soft glyph shadows). Controls are always
  the dark/white look regardless of app theme (a video surface convention).
- **Idle**: controls fade after 2 s while playing and the pointer rests (not while paused, a panel is open,
  or the seek bar is dragged); cursor hides. Centre "flash" feedback on play/pause/skip/speed/volume.
  Big centre play button while paused.
- **Keyboard**: Space/K play, ←/→ 5 s, ↑/↓ volume, M mute, F fullscreen, P picture-in-picture, R loop,
  `<`/`>` speed ±0.25, 0–9 jump. Focus rings only after keyboard input.
- **Picture in picture**: Document Picture-in-Picture window holding the whole player (same `<video>`
  element moved, keeps playing); page shows a placeholder with "Bring back". Falls back to the browser's
  video PiP when unavailable or refused (inside a frame Chrome refuses: "only allowed from a top-level
  browsing context") with a `console.warn` naming the reason; only `DOMException` falls back — any
  other error throws.

## Approach

### 1. Slider gets a vertical orientation — `plugins/primitives/plugins/css/plugins/slider`
`Slider` (`web/internal/slider.tsx`, `slider.css`) is horizontal only. Add `orientation?: "horizontal" |
"vertical"` there (track geometry and thumb travel belong to the slider, not to a CSS rotation in the
caller). The volume capsule uses it. Check the prototype's geometry (thumb concentric with the capsule's
round ends) is expressible; if the slider's own inset rules conflict, extend the slider, don't hack around it.

### 2. New primitive — `plugins/media/plugins/player/`
`web/index.ts` exports `MediaPlayer` (and its props type). Proposed props:
`{ kind: "video" | "audio"; src: string; label: string; autoPlay?: boolean; onError?(error: MediaError | null): void; mediaKey?: string }`
(the caller keeps its own error UI and Retry remount, as `media-view.tsx` does today).

Internal decomposition (`web/components/`, `web/internal/`): `player.tsx` (state + element), `control-pill`,
`seek-bar`, `volume-capsule`, `settings-panel`, `speed-dial`, `center-feedback`, `use-idle`,
`use-media-state` (subscribes to the element's events → one state object), `document-pip`.

Reuse, don't re-roll:
- `IconButton` (`@plugins/primitives/plugins/icon-button/web`) inside a `ControlSizeProvider` for the pill
  buttons; icons via `symbol(...)` at module scope: `play-arrow`, `pause`, `volume-up/down/off`,
  `settings`, `fullscreen(-exit)`, `picture-in-picture-alt`, `repeat`, `restart-alt`, `replay-5`, `forward-5`.
- Tooltips with shortcut badges: `IconButton`'s `shortcut` / `TooltipDoc` + `Kbd`.
- `Switch` / `SwitchIndicator` (`css/switch`) for Loop; `SegmentedControl` (`css/toggle-chip`) for the presets;
  check `css/control-panel` rows for the Loop / PiP rows (`no-row-in-panel` lint).
- Glass: follow `image-viewer/web/components/viewer-chrome.tsx` (`PANEL = cn(SURFACE_LEVELS.overlay,
  "bg-popover/80 backdrop-blur-md")`) and, for portaled popovers, the `--popover-fill` /
  `--popover-backdrop` variables (`overlay/floating-action`). Render the controls in a fixed dark scope so
  tokens resolve to the prototype's dark glass (find how `apps-core/chrome-theme` applies its fixed theme).
  If the token system cannot express the `clear` recipe exactly, the agent stops and reports the gap — no
  raw `rgb()` / arbitrary values to force it.
- Typography / spacing / radius / z: `Text` roles or `text-<role>` (+ `font-mono`/tabular for times),
  spacing ramp, `rounded-full`, `z-raised` for the pill. The repo's lint rules (no-adhoc-typography,
  no-adhoc-spacing, no-adhoc-radius, no-adhoc-zindex, no-adhoc-surface, no-adhoc-control,
  no-unanimated-surface-exit → `Presence`) are binding.
- Shortcuts: `usePlayPauseShortcut` for Space and `useSurfaceShortcuts` for the rest (no raw keydown).
  Watch the double toggle: a focused pill button activates on Space keyup while the shortcut fires on
  keydown — make the player's own buttons not re-toggle (or claim the key) and test it.
- Fullscreen: check `plugins/fullscreen` for a reusable hook; the player puts its own root in fullscreen.
- Document PiP in React: render the player through `createPortal` into a host `<div>` the player owns,
  and move that host node between documents (React listens on portal containers, so events keep working).
  The PiP document needs the page's stylesheets, the `<html>` theme attributes/variables **and the inline
  icon sprites** (`ui/icons` mounts sprites inline; `<use href="#…">` breaks without them).
- **Audio**: no video to float over, so the same pill renders as a static bar (no idle fade, no
  fullscreen / PiP, settings = speed + loop) on a regular overlay surface. Small extrapolation of the
  prototype — flagged for review.
- Exhibits (`exhibits/index.ts`, `isolatedExhibit`): `media-player/video`, `media-player/video-settings-open`
  (or an option), `media-player/audio`, using a tiny generated clip (≤ 200 KB, made once with the
  `media/ffmpeg` dependency, e.g. a 5 s testsrc webm with tone) committed under the plugin.
- Tests (`web/__tests__/`, vitest + jsdom, stub `HTMLMediaElement.prototype` play/pause/duration, fire
  `timeupdate`/`loadedmetadata`): play/pause + Space no double toggle, seek drag maths, volume capsule
  mapping incl. ends, speed dial snapping/clamping and keyboard, idle rules, PiP fallback only on
  `DOMException`. Pure maths (dial ↔ rate, time format) as `*.test.ts` beside the source.

### 3. Migrate the consumers
- `primitives/file-viewer/media/web/components/media-view.tsx`: `MediaPlayer` replaces both elements; keep
  `useAssetSrc`, `mediaFailure`, `NoPreview` + Retry remount, autoplay. Drop its own
  `usePlayPauseShortcut` (the player owns it). Update its `e2e/media-verify.ts` if selectors change
  (a `<video>`/`<audio>` stays in the DOM).
- `page/video` and `page/audio` blocks: `MediaPlayer` replaces the elements; no autoplay; the
  top-right "Replace" pin must not collide with the pill (bottom) — check.
- `shortcuts/use-play-pause-shortcut.ts`: `nativeMediaClaims` stays correct for native elements; adjust
  only if the player needs it.
- Out of scope (programmatic / not native controls): Sonata, YouTube, film engine, Chord.

## Execution by agents

1. **Agent A — Opus** (load-bearing, complex UI): steps 1 + 2 (slider orientation, the primitive, tests,
   exhibits). Builds with `./equin build` (background + `./equin await`), runs `./equin check` and
   `./equin test` on the touched plugins.
2. **Agent B — Opus**, after A: step 3 (migrations), build, check. (User asked for Opus on all implementation.)
3. **Me**: pixel comparison against the prototype
   (`compare-diff.ts`, with `<meta name="mocks" content="exhibit:media-player/video">` added to the
   prototype), screenshots of the three surfaces, then one independent **Sonnet review** of the diff
   against the merge-base. Report to the user; no push without instruction.

Agents run sequentially in this worktree (never two builds at once). Each agent stops and reports on an
unexpected failure or a token-system gap instead of improvising.

## Verification

- `./equin check` clean; `./equin test plugins/media/plugins/player plugins/primitives/plugins/css/plugins/slider`.
- `./equin run plugins/apps/plugins/prototypes/plugins/compare/e2e/compare-diff.ts --name proto-1793924689-zwfacl`
  (prototype vs exhibit, low diff ratio).
- `./equin run plugins/primitives/plugins/file-viewer/plugins/media/e2e/media-verify.ts --file <an mp4>`.
- `browser_*` on this worktree's build: file viewer video + audio, a page with video/audio blocks — play,
  seek, volume, speed dial, loop, fullscreen, keyboard; Document PiP from the top-level app page.

# render-loop

## What a report says, and what it cannot

The DOM tells WHERE writes land, not WHO causes them. Two React 19 artefacts
make a component's re-render look like a write with no writer: every commit
of an `<input>` re-assigns its `name` (`noop-attr` on `name`, value `""`), and
every commit of a `<textarea>` with `defaultValue` re-assigns it (its text
node replaced, a childList record). So a `noop-attr name` on an input means
"the component rendering this input re-renders N times a second".

To name the cause, the detector borrows `debug/render-profiler` once a loop
passes every gate: it watches React's commits for `RENDER_LOOP.ATTRIBUTE_MS`
before filing, and the report carries `reactCommitsPerSec` and `initiators`
(the component whose own state / store / context changed, and which hooks).
Only components re-rendering at `ATTRIBUTE_MIN_COMMITS_PER_SEC` or more are
named (the app's background commits are not a loop's cause); an empty
`initiators` means no React re-render drives the writes — an imperative loop. Compositions without the profiler file without attribution.

## What counts as the user acting

Idle means no `pointerdown` / `pointermove` / `keydown` / `wheel` / `scroll`
/ `input`, and no window `resize` or Safari `gesturechange`, for `IDLE_MS`.
A window being resized sends the page no input, yet everything sized by it
re-lays out each frame (a map redraws its tiles): counting it keeps that out
of the reports, while a layout-driven loop (a ResizeObserver oscillating)
fires no window resize and is still caught.

The user must stay idle through the attribution window too: the window
watches React's commits, and input there makes them the user's (panning the
map again names the map's camera re-render as the "loop's" cause). A
detection the user interrupts is dropped (logged as `interrupted`) and may
fire again later.

A script moving the page (an agent's headless browser calling the map's
`moveCamera`, resizing a box) sends no input either, so what it drives reads
as idle. Every report such a browser files says so up front — `report()`
prefixes `(automated browser)` (`scope/automation`) — never muted.

## Animation hosts

An intended imperative animation (a rAF loop drawing an SVG scene) writes
thousands of attributes a second while the user is idle, which is exactly a
loop's shape. It draws inside `<AnimationHost>` (web: `<AnimationHost ref={…}
className="…" />`): records on its descendants that React does not own are
skipped. The host takes **no children** — React renders the empty box and the
script builds everything inside it, skeleton included. A React-rendered node
inside a host stays watched (a re-render loop there must still fire), so a
script writing into one reads as a loop: the story's Backlog figure kept its
counters and row lists in React and filed a 19/s cascade until it built them
itself. With no `children` prop, that shape has no spelling.

**A third-party renderer** (a Google map) is the same case with React
children inside: the library builds and rewrites its own DOM on every camera
move (tiles, controls, the scale text) while its React bindings and our
portals render inside it. It draws inside `<ForeignDomHost>` (web), which
takes children: the library's nodes are skipped, React's stay watched — a
component looping inside it still files (`web/__tests__/foreign-dom-host.test.tsx`).
Before it, an automated tab whose camera kept moving filed Google's own
controls as 73–145/s loops (`map.google`, 2026-11-19).

Every node's classification (skipped, or its culprit meta) is computed on its
first record and cached in a WeakMap: the observer's per-record cost is O(1)
for a node it has seen, which is what keeps an animation from making the
detector itself a frame cost (it was 91 ms in one frame of the demo).

## Playback

A player that is playing renders on its clock — React-owned nodes too (a
playhead, the keys lighting as notes sound) — while the person listens without
touching anything, so the idle gate alone reads it as a loop (Sonata playing a
dense piece on the website demo: 89/s across 17 keys). The session that owns a
timeline's play state holds `holdPlayback()` (core) while it plays and releases
it when it stops; the detector counts a held playback as activity, like input,
and judges idleness from the last moment one was held. Hold it only around real
playback: it silences nothing outside it.

## Attributing a loop to a culprit

`web/internal/culprit-signature.ts` reads the composition lineage via
`primitives/ui-context`'s exported walks (`isMarkerSpan`, `nearestSource`,
`nearestOwner`) — don't re-derive local copies; that is how they last diverged.

Bespoke to this detector, and deliberately NOT `ui-context`'s equivalents:
`boundedPath` uses `nth-of-type`, not `nth-child`, so sibling text/comment nodes
appearing during a rebuild don't change the identity — `signature` is a `Map` key
that must survive a React teardown→rebuild. `aggregateRoot` is the coarse
subtree-cascade rollup. `data-pane-id` is a separate DOM convention `ui-context`
does not own.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Render-loop detector: a single invisible global controller (mounted via Core.Root) that installs one MutationObserver and files a deduped render-loop report when a subtree is rebuilt/re-mutated at a sustained high rate while idle, visible, and doing no meaningful work (wasted DOM thrash). Render-loop report kind: validates render-loop payloads, fingerprints by signature + mutation class, and renders per-loop perf tasks. Re-arms periodically (6h) since a still-present loop is a warning, not a one-shot crash.
- Web:
  - Contributes:
    - `Core.Root` → `RenderLoopController`
    - `Reports.KindView` → `RenderLoopKindView`
  - Uses:
    - `primitives/css/badge.Badge`
    - `primitives/css/inline.Inline`
    - `primitives/log-channels.clientLog`
    - `primitives/ui-context.isBoxlessMarker`
    - `primitives/ui-context.nearestOwner`
    - `primitives/ui-context.nearestSource`
    - `reports.report`
    - `reports.Reports`
  - Exports (types):
    - `AnimationHostProps`
    - `ForeignDomHostProps`
    - `InlineAnimationHostProps`
  - Exports (values):
    - `AnimationHost`
    - `ForeignDomHost`
    - `InlineAnimationHost`
- Server:
  - Contributes: `report-kind` "render-loop"
  - Uses: `reports.ReportKind`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/font-family --font-mono`
  - Imported by:
    - `apps/sonata/session`
    - `apps/website/pages/foundations`
    - `apps/website/pages/story/data-views`
    - `apps/website/pages/story/essay`
    - `apps/website/pages/story/heads`
    - `apps/website/pages/story/skills-graph`
    - `apps/website/pages/vision`
    - `map/google`
- Core:
  - Exports (types):
    - `RenderLoopInitiator`
    - `RenderLoopPayload`
  - Exports (values):
    - `ANIMATION_HOST_ATTR`
    - `holdPlayback`
    - `playbackHeld`
    - `RENDER_LOOP`
    - `renderLoopFingerprint`
    - `RenderLoopPayloadSchema`

<!-- AUTOGENERATED:END -->

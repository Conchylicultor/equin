# vision

The vision page at `/about/vision` — the vision for applications, as one
Powers of Ten zoom-out on a dark starfield. (The apps themselves are listed by
its sibling, the gallery at `/about/apps`.) Ported from the prototype
`proto-1792811767-vd1ygi`, which stays the design reference, at the options
picked on it: `direction: zoom`, `variant: b`, `fit: b` (the page IS the zoom:
the heading dissolves into it, a layer strip under the header, no side gauge),
`copy: paragraphs`, `os: orbit`. Re-check the picks (`./equin prototype
options <id>`) before porting a change; only those picks are implemented.

- The heading (`WebsiteHero`, "A vision for applications") fills the first
  screen of the pane and fades / lifts away over the first 60% of a scroll
  (`--h`); the ladder is pulled up under it, so the zoom starts from it.
- A pinned stage (one screen of the pane's viewport) draws the zoom; six
  chapter cards scroll over it (`internal/ladder.ts`, the prototype's copy
  verbatim — a chapter with no `before` shows only its present). Scroll
  progress p is where the reading line sits among the cards' centres, held
  at a chapter while its card is read. The line is where the layout puts the
  copy (`Zoom.readingLine`: the screen's middle beside the scene, the band
  under it on narrow screens), so a reader at rest sees the chapter, never a
  hand-off half-way through.
- Every on/off decision taken from p (chapter 2 coming apart, its apps handing
  over to the OS's windows) is a `latch` (`kit/math.ts`): on at one value, off
  only below a lower one. A page at rest at a threshold (a thumb, a phone's
  toolbar resizing the pane) must not flip it back and forth.
- Frame k fills the scene at p = k and is a smaller thing inside frame k + 1 at
  p = k + 1 (`chapters/geometry.ts`'s `IN`): an idea's spark → the app's
  improve button → the window chapter 2's apps play in → that window coming
  apart into a desktop orbit → your orbit among everyone's → people on a
  turning globe by night.
- The layer strip (segments filling with p, the chapter's number and name) is
  pinned under the site header while the ladder is read; a segment jumps to
  its chapter. The header frosts once content scrolls under it
  (`WebsiteChrome headerGlass`).

## How it is built

React renders the markup ONCE (`components/vision-zoom.tsx`: the hero, then
the memoised ladder with no props) and hands the DOM to imperative owners,
exactly as the prototype's scripts owned theirs. Never let React re-render the
ladder.

- `internal/ladder-scroll.ts` — the scroll skeleton: the page's measures
  (`--screen`, `--vs-head`, `--h`), scroll → p, the cards' lit state, the
  layer strip. Everything scrolls inside the PANE: reads go through the pane's
  scroll container (`findScrollParent`), never `window`.
- `internal/zoom.ts` — the engine: mounts every frame (a disc behind, a
  drawing in front), places them by the camera for p, fades them, and runs
  the frames' own animations on ONE rAF loop, only while the stage is on
  screen and the tab visible, and only for the frames that are visible. The
  engine sees a frame, not its layers: a chapter that fades its own layers
  out (chapter 4's orbits and nodes, at opacity 0 on chapter 5) stops posing
  them there and only moves their state on. A hidden layer is also
  `content-visibility: hidden`, so the CSS animations inside it (the idea's
  pulses, chapter 2's falling notes) are not restyled every frame. Every
  attribute written is a style recalc of that element; `e2e/vision-frames.ts`
  prints, per chapter and per frame, the CPU, the DOM writes and the elements
  restyled (`--gpu` to render as a visitor's browser does: in the default
  software raster a canvas's pixels are copied on the main thread, `Commit`).
- A drawing whose many marks ALL move every frame is drawn on a canvas
  instead of as SVG nodes (`kit/surface.ts`): the globe (chapter 5) — its grid
  and lights over its disc, its people, arcs and packets over everything — on
  two screen-space canvases the engine places, fades and stacks exactly as the
  frame's SVG layers (same transform, opacity, z-index), repainted whole on
  every tick and on every placement. Its strokes keep the old
  `non-scaling-stroke` widths: SVG-viewport units, which the frame's CSS
  scale still scales, so in a surface they are frame units like the rest.
  `e2e/vision-globe-shots.ts` photographs the globe at fixed p and fixed
  animation times (Playwright's fake clock) and diffs two runs — the parity
  check for a change to how it is drawn.
- `internal/chapters/` — one module per chapter (`idea`, `app`, `integrate` +
  its apps `integrate-apps`, `desktop`, `apart` (2 → 3), `os-orbit`,
  `shared`, `globe`), and `orbit-kit` (the sphere projection, an app as a
  plain shape, the person node) shared by chapters 3–5.
- `internal/kit/` — the drawing kit: `math.ts` (easing, a seeded generator —
  generated shapes are the same on every visit — polyline geometry),
  `svg.ts` (markup strings), `surface.ts` (a frame layer as a canvas), `night.ts` (the night-orbs vocabulary: glowing
  lines, windows, beads, chips, icons, the OS's abstract windows),
  `timeline.ts` (a frame's looping animation as a pure function of loop
  time: parts tweened by `at(t, part, to, dur)`), `palette.ts`.

Everything registered (the scroll listener, the in-view watcher, the
visibility listener, the rAF loop, the resize observer, the section-reach
observers) is disposed on unmount.

Analytics: each chapter card records `section_reach` as `vision/<key>` (`idea`,
`app`, `integrate`, `os`, `share`, `every`); the heading records `vision/hero`
through `WebsiteHero`.

## Colours

The zoom's palette is one illustration's fixed palette — a starfield, dark
discs, the blues, teals and violets its drawings glow in — the same in light
and dark mode, because the picture does not change with the mode. It is
declared ONCE, as custom properties on `.vision-zoom`
(`components/vision-zoom.css`), and the drawings' markup names them only
through `internal/kit/palette.ts` (`var(--vz-…)` references). This is the
website's sanctioned exception to "colour comes from the theme" (see the
website `CLAUDE.md`), like the foundations iceberg; nothing outside
`.vision-zoom` may read these variables. The page's own text — the cards and
the layer strip — reads the site's theme tokens.

The nav link is contributed into the shell's shared `WebsiteHeader`, so the
shell never names this page. The homepage's third layer card (the vision) and
the apps gallery's read-next card open it. The `WebsiteVision.Section` slot
renders below the zoom.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The vision page of the equin website: the /about/vision pane on the vision for applications — one Powers of Ten zoom-out on a dark starfield, six chapter cards scrolling over a pinned stage (an idea, an app that reshapes itself, apps that integrate, a personal OS, apps shared between people, every app rebuilt) with a layer strip under the header — its Vision nav link, and the WebsiteVision.Section slot for sections below it. The vision page of the equin website on the server: its sitemap entry (WebsitePages.Page).
- Web:
  - Slots: `WebsiteVision.Section`
  - Contributes:
    - `Pane.Register` "website-vision"
    - `WebsiteHeader` "vision" → `VisionNavItem`
  - Uses:
    - `apps/deploy/analytics/collect.observeSectionReach`
    - `apps/website/shell.WebsiteChrome`
    - `apps/website/shell.WebsiteHeader`
    - `apps/website/shell.WebsiteHero`
    - `apps/website/shell.WebsiteNavLink`
    - `apps/website/shell.websitePagePart`
    - `primitives/dom/auto-scroll.findScrollParent`
    - `primitives/dom/element-size.useResizeObserver`
    - `primitives/dom/in-view.createInViewWatcher`
    - `primitives/dom/scroll-reveal.revealElement`
    - `primitives/pane.defineRoute`
    - `primitives/pane.Pane`
    - `primitives/pane.useOpenPane`
    - `primitives/slot-render.defineRenderSlot`
  - Exports (values):
    - `visionPane`
    - `WebsiteVision`
- Server:
  - Contributes: `apps.website.crawlable.page` "/about/vision"
  - Uses: `apps/website/crawlable.WebsitePages`
- Core:
  - Uses: `apps/website/crawlable.defineWebsitePage`
  - Exports (values): `visionPage`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/chart --chart-1`
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --faint-foreground`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/density --space-2xl`
    - `ui/tokens/font-family --font-sans`
  - Imported by:
    - `apps/website/landing/layers`
    - `apps/website/pages/apps`

<!-- AUTOGENERATED:END -->

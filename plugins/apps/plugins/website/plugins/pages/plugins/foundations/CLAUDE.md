# foundations

The technical foundations page at `/about/foundations`: what equin brings on
top of Claude, drawn as an iceberg — ten layers from the apps at sea level down
to the loop that built everything above it. Ported from the prototype
`proto-1790334655-cs0c`, which stays the design reference, at the options
picked on it: `finish: soft`, `header: sticky`, `split: icon`, `mark: wrench`.
Re-check the picks (the prototype's options pill) before porting a change.

- Every piece is a pill that opens **in place** into a card; 35 of them carry a
  live drawing (`web/internal/cards/`). The piece under the cursor holds still
  while its neighbours and the berg glide to where they land (FLIP). The apps
  (sea level) start as pills — the sky is sized for them — and every piece
  below the waterline starts open, its drawing mounted on boot.
- Under the last layer, the agents that built it (`components/agent-crew.tsx`):
  three small hovering robots over a lit sea floor named Claude — two carry
  blocks up behind the last layer's cards (the foot sits under the layers,
  `z-index: 0`) and come back empty, one patrols — with bubbles rising. Pure
  CSS motion, outside the card runtime; its colours are the scene's
  `--berg-agent-*` variables.
- Under the title, the site's scroll cue (`WebsiteScrollCue`, a V placed by
  `.iceberg-dive`): a click descends to the first layer under the surface.
- A depth gauge (lines of code passed below the surface), a Components /
  Harness filter under the title, and Expand all (the pill, or `E`).
- Each layer's line count (`core/layer-loc.ts`) is code only — tests, test
  support, e2e scripts and generated files left out — and is written by
  `scripts/count-loc.ts`, which assigns every source file to a layer by path
  (longest prefix in its `LAYER_OF` table) and fails on a file no layer
  claims. Refresh it with
  `./equin run plugins/apps/plugins/website/plugins/pages/plugins/foundations/scripts/count-loc.ts`.
- Harness pieces are plain chips like the rest, told apart by the wrench in
  front of their name (teal on the ice, cyan in the deep); the Harness key
  carries the same wrench.
- The site header stays pinned: bare over the top of the sky, frosted once the
  page moves, in the sky's dark ink over the sky and in light ink once the
  waterline passes its middle (`icebergSkyHeaderTheme` / `icebergSeaHeaderTheme`,
  chosen by the scene's `onHeaderOver` and worn through `WebsiteChrome
  headerTheme` + `headerGlass`). A gauge jump lands a layer below the bar
  (`scroll-margin-top`).

## How it is built

React renders the scene's markup ONCE (`components/iceberg-section.tsx`,
memoised, no props) and then hands the DOM to two imperative owners, exactly as
the prototype's scripts owned theirs:

- `internal/iceberg/scene.ts` — the berg (one SVG strip per layer, drawn from
  the layers' measured offsets by `berg.ts` / `geometry.ts`), the sky fitted to
  exactly one screen of the pane's viewport, the gauge, the filter, Expand all,
  and open / close with its FLIP glide. Everything scrolls inside the PANE, so
  reads and writes go through the pane's scroll container (`findScrollParent`,
  `keepInPlace`, `scrollChildIntoView`), never `window`.
- `internal/kit/` — the card runtime (`runtime.ts`), its drawing helpers
  (`draw.ts`, markup strings) and classes (`kit.css`). A card is
  `defineCard({ states, autoplay, render, mount, actions })`; its markup is
  rendered once and a state change only flips attributes (`data-in` → shown,
  `data-on` → lit, `data-at` → a part's own state). Autoplay ticks only cards
  that are open and on screen; everything a card registers through its `ctx` is
  disposed when it closes.
- Every arrow is the kit's ONE connector, `k.link`, with one motion: whenever
  it appears (`in`) or lights (`lit`, `on`, or a `ctx.fire(shot)`) it draws
  itself from its start in `--k-draw`, the arrowhead arriving with the stroke,
  and a token it `send`s rides the tip. Something travelling along a link is
  that link lighting, never a free-floating dot; `k.dot` is only a looping
  stream of traffic. Never animate a link in a card's own CSS.

Never let React re-render the scene: a reconciled node mid-glide, or a card's
markup rebuilt, is exactly the flicker the prototype was designed to avoid.

## Content and copy

`internal/iceberg/data.ts` is the prototype's `data.js`, verbatim; `CARDS` in
`internal/cards/index.ts` is the closed list of drawings, and a piece names its
card by key (`CardKey`, derived from the map, so a missing card does not type).

The copy follows the prototype's rules: facts, not slogans — say what the
feature does and, after "so", its concrete consequence; no aphorisms, "X, not
Y", punchlines after a colon, rhetorical questions, slogan triads,
personification or teasers; no tuning numbers. The hero caption is the
exception, in the author's own voice. A drawing never instructs ("click to…",
"try it"): its controls must look clickable on their own.

## Colours

The scene's palette is one illustration's fixed palette — a white sky, a sea
darkening to black, cold ice and the Harness's teal mark — the same in light
and dark mode, because the picture does not change with the mode. It is
declared ONCE, as custom properties on `.iceberg` (`components/iceberg.css`),
plus the kit's two palettes (`k-sun` / `k-deep`, `internal/kit/kit.css`), and
read through them by everything in the scene — the berg's SVG gradients
included. This is the website's sanctioned exception to "colour comes from the
theme" (see the website `CLAUDE.md`); nothing outside `.iceberg` may read these
variables.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The technical foundations page of the equin website: the /about/foundations pane drawing what equin brings on top of Claude as an iceberg — ten layers from the apps at sea level down to the loop that builds them, each piece a pill that opens in place into a card (many with a live drawing), with a depth gauge, a Components / Harness filter and Expand all — and its entry in the header's Learn menu. The technical foundations page of the equin website on the server: its sitemap entry (WebsitePages.Page).
- Web:
  - Contributes:
    - `Pane.Register` "website-foundations"
    - `Website.LearnEntry` "Foundations" → `FoundationsNavItem`
    - `ThemeEngine.SubTheme` "iceberg sea header"
    - `ThemeEngine.SubTheme` "iceberg sky header"
  - Uses:
    - `apps/deploy/analytics/collect.observeSectionReach`
    - `apps/deploy/analytics/collect.track`
    - `apps/website/shell.Website`
    - `apps/website/shell.WebsiteChrome`
    - `apps/website/shell.WebsiteHeader`
    - `apps/website/shell.WebsiteLearnLink`
    - `apps/website/shell.websitePagePart`
    - `apps/website/shell.WebsiteScrollCue`
    - `primitives/dom/auto-scroll.findScrollParent`
    - `primitives/dom/auto-scroll.keepInPlace`
    - `primitives/dom/auto-scroll.scrollChildIntoView`
    - `primitives/dom/element-size.useResizeObserver`
    - `primitives/dom/in-view.createInViewWatcher`
    - `primitives/dom/in-view.InViewWatcher`
    - `primitives/pane.defineRoute`
    - `primitives/pane.Pane`
    - `primitives/pane.useOpenPane`
    - `primitives/shortcuts.useSurfaceShortcuts`
    - `reports/render-loop.InlineAnimationHost`
    - `ui/theme-engine.ThemeEngine`
  - Exports (values): `foundationsPane`
- Server:
  - Contributes: `apps.website.crawlable.page` "/about/foundations"
  - Uses: `apps/website/crawlable.WebsitePages`
- Core:
  - Uses: `apps/website/crawlable.defineWebsitePage`
  - Exports (values):
    - `foundationsPage`
    - `LAYER_LOC`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/density --chrome-pane-h`
    - `ui/tokens/font-family --font-mono`
    - `ui/tokens/font-family --font-sans`
    - `ui/tokens/shape --spacing`
  - Imported by:
    - `apps/website/landing/layers`
    - `apps/website/pages/apps`

<!-- AUTOGENERATED:END -->

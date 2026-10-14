# Website Foundations page ↔ proto-1790334655-cs0c (the iceberg)

## Context

`/website/foundations` is a placeholder: a hero, the "More details soon" note, and an empty
`WebsiteFoundations.Section` slot. The prototype `proto-1790334655-cs0c` is the designed page. It is
an iceberg of 10 layers, running from the apps at sea level down to the self-building loop. It holds
60 pieces, and each piece is a pill that opens in place into a card. 31 of the cards carry an
animated or interactive visualization.

The user's decision (2026-10-13) is to **match the mockup perfectly**: all animations, colours,
features and interactivity, with every option at its default (`finish=soft`, `header=floating`,
`split=tint`, `mark=wrench`). That means:

- the light sky,
- all 31 cards,
- the full FLIP open and close,
- the depth gauge,
- Expand all with the `E` shortcut,
- the Components/Harness filter.

Prototype code may be copied, but it gets a cleaner React structure.

## What is kept from the site, not the mock

- **Header.** The mock's nav is a stand-in for the site header. The page keeps the shared
  `WebsiteHeader` (wordmark, full nav, Improve) through `WebsiteChrome`.
  - While it floats over the sky, the header wears **dark ink**. See "Header over the sky".
- **Footer.** The mock's `#site-foot` is a stand-in too, so the page keeps `WebsitePage`'s footer.
  - The mock's closing line still renders above it: "At the bottom of the iceberg is the loop that
    built everything above it."
- **Scroll container.** The pane scrolls, not `window`. Every scroll, resize and screen-height read
  is made against the pane's scroll element:
  - the gauge,
  - `topbar.deep`,
  - the scroll pin,
  - fit-to-screen, which replaces `--prototype-screen-height` with the scroll element's
    `clientHeight`.
  - The gauge and the Expand-all pill sit `position: sticky` / fixed relative to the pane, not the
    viewport.

## Structure

```
pages/plugins/foundations/
  web/panes.tsx                      ← drop FoundationsOpening + WebsiteSoon; render only the slot
  web/components/foundations-opening.tsx   ← delete (the iceberg owns its hero)
  CLAUDE.md                          ← no longer a placeholder
  plugins/iceberg/                   ← NEW child plugin, contributes WebsiteFoundations.Section "iceberg"
    CLAUDE.md, package.json
    web/index.ts
    web/internal/
      layers.ts          ← data.js, verbatim and typed: IcebergLayer { name, tag, loc, items }, IcebergItem
                           { name, weight: 1|2|3, desc, card?: CardKey, kind: "infra"|"harness" }
      berg-geometry.ts   ← pure: HW tables, maxHalf, seeded PRNG, bergPoints, cuts, unitY, stripStops,
                           rowWidths, tipOffset (+ berg-geometry.test.ts)
      fit.ts             ← fitSurface port (--fit step-down, 40/60 spare split)
      flip.ts            ← holdStill port: snapshot rects → change → redraw → scroll pin → WAAPI glide
                           (GLIDE_MS 420, EASE, ::after box inset/radius, .nm scale, ghost on close,
                           reduced-motion off, glideUntil guard)
      depth.ts           ← gauge readout maths (loc sums, "Sea level" / "lines below the surface")
      card-kit/          ← React port of kit.js (see below)
    web/components/
      iceberg-section.tsx   ← scene root: owns open set, filter, expand-all, layout effects
      iceberg-hero.tsx      ← HERO copy verbatim, the split key, "Descend ↓"
      berg-strips.tsx       ← one <svg class="band"> per layer from measured offsets
      iceberg-layer.tsx, iceberg-item.tsx
      split-key.tsx, depth-gauge.tsx, expand-all.tsx, harness-mark.tsx (wrench)
      iceberg.css            ← index.html's page CSS (defaults only), class prefix `iceberg-`
      cards/
        index.ts             ← closed map CardKey → CardDef, assembled from per-layer files
        shell.tsx, primitives.tsx, plugins.tsx, data.tsx, state.tsx,
        background.tsx, watching.tsx, machine.tsx, loop.tsx   ← one file per layer, its cards
        card-kit.css         ← kit.css
    e2e/foundations-verify.ts
```

Why one child plugin, and not a plugin per layer or per card:

- The scene is one measured drawing. The berg spans every layer, the FLIP moves every item, and the
  gauge reads every layer. It cannot be split across slot contributions.
- The card set is a **closed, authored list**. Per the root CLAUDE.md, that makes it plain data
  (`Record<CardKey, CardDef>`), not a slot.
- `CardKey` is derived from the map, and `layers.ts` is typed against it. tsc then rejects a piece
  naming a missing card. That replaces the gallery's "missing card file" check.

The homepage's first layer card (`landing/plugins/layers`) **loses its "More details soon" badge**.

## Colours

The scene is mode-independent by design: a sunlit sky above the water and the abyss below it. Its
palette is the mock's exact values:

- sky,
- sea ramp `s0–s3`,
- ice gradients,
- amber harness tint,
- `k-sun` / `k-deep` kit palettes,
- gauge cream.

It is declared **once**, as CSS custom properties on `.iceberg-scene` in `iceberg.css`:
`--berg-sky-*`, `--berg-sea-*`, `--berg-loop-*` and `--k-*`. Every component and card reads those
variables, so no `.tsx` holds a colour literal, which `no-hardcoded-colors` forbids anyway.

- The blue and cyan identity stops are mixed from the theme's `--primary` / `--chart-1`. They are
  equal to the mock's `#2563eb` / `#22d3ee` within the equin palette.
- The website `CLAUDE.md` gains this as its second sanctioned exception, next to the vertical
  rhythm. The iceberg's sky and sea are one illustration's fixed palette, the same in light and dark
  mode. They are declared in one place and never reused outside the scene.

## Header over the sky

- `WebsiteChrome` gains an optional `headerTheme` prop: a sub-theme the floating header wears.
- The iceberg passes a palette fragment that inverts the header's foreground, muted and secondary to
  the mock's ink (`#0b1220` / `#566275`, with the Improve pill dark).
- Header `floating` scrolls away in the mock. Ours already masks after the first scroll. Once the
  header is masked, it reverts to the default dark palette.
- If the theme engine cannot scope only the header region, the fallback is a `data-over-sky`
  attribute on the header region that `iceberg.css` keys from. This gets verified first.

## Card runtime (`card-kit/`)

The port keeps kit.js's semantics exactly. Each card becomes JSX in place of strings.

- `defineCard({ width: "std"|"wide", states?, start?, autoplay?, render: Component })`.
  - A `caption` field is rejected by the type.
  - `autoplay` without `states` or `step` is a type error, using a discriminated union.
- `useCard()` returns `{ state, go, run, after, frame, on, fire, highlight, hold, part }`. All timers,
  rAF and listeners are disposed on unmount.
  - Web `setTimeout` and rAF are allowed. `no-raw-set-interval` covers server code only.
- Gating helpers replace `data-in`, `data-on`, `k-off`, `k-enter`, `k-sel` and `data-replay`: they
  emit the same classes from `state`, and they keep the kit's enter-fade and swap behaviour.
- **Height lock:** before first paint, a layout effect visits every state with `flushSync`, measures
  each one, and locks `min-height` to the tallest. It re-measures on `document.fonts.ready`.
- **Shared autoplay scheduler:** one module-level ticker.
  - Visibility comes from `useInView` (`primitives/dom/in-view`, the sanctioned IntersectionObserver).
  - Per-state `every` and `lead` are honoured.
  - User idle hold is `IDLE = 8000`.
  - Autoplay is off under `prefers-reduced-motion`.
- **Drawing helpers** are `Kit` as small JSX components: `Svg`, `KText`, `Box`, `PluginBox`, `Chip`,
  `KButton`, `Link`, `Legend`, `KIcon` (the 14 Lucide paths), `CodeLines`, `Cylinder`, `KWindow`,
  `Dot` (SMIL `animateMotion`), `Check`, `Spinner`, plus the HTML helpers.
  - Card controls are real `<button>`s, or `role="button"` elements with Enter and Space handling.
- Cards mount on open and unmount on close, exactly like `Cards.open` / `Cards.close`.

## Execution

1. **Foundation (me, sequential).** I build these first:
   - the plugin scaffold, `layers.ts`, the geometry with tests, `fit`, the berg strips, items, open
     and close, FLIP, filter, gauge, Expand all and the `E` key, the header theme, the page CSS, the
     card kit, and the colour variables;
   - two reference cards: `plugin` (static) and `window` (the hardest interactive one).
   - Then I build and compare against the mock, until the scene without cards matches.
2. **Card fan-out (parallel Sonnet agents in this worktree, disjoint files).** The work is split into
   about 5 agents, each owning whole per-layer card files:
   - A: shell (tabs, themes, layout, crossapp) and primitives (dataview, richtext, mentions)
   - B: plugins (slots, plugtree, compose) and data (live, optimistic)
   - C: state (forks, migrations, blocks, protected) and background (triggers, durable)
   - D: watching (isolation, profiling, background, status) and machine (gateway, central, hotswap)
   - E: loop (loop, envs, guards, sessions, cli)

   Each agent works from these inputs:
   - the prototype `card-<key>.js`,
   - the two reference cards,
   - the kit API,
   - the copy rules in the prototype's CLAUDE.md, which means its labels are copied verbatim.

   Agents don't build. They run `./singularity check type-check` on their own files and hand back.
   `cards/index.ts` is pre-created with every key stubbed, so no two agents edit the same file.
3. **Integrate and verify (me).** I build, then run the full verification below, then send fixes
   back to the owning agent.

## Verification

- **Unit tests.** `./singularity test plugins/apps/plugins/website/plugins/pages/plugins/foundations`
  covers the berg geometry, row widths, fit and the depth readout. Each is checked against values
  computed from the prototype's formulas.
- **Build.** Run `./singularity build` in the background.
- **Pixel comparison.** Add `<meta name="mocks" content="/website/foundations">` to the prototype,
  then run `compare-diff.ts --name proto-1790334655-cs0c`:
  - at 1280 and 1920, and at a phone preset;
  - first screen, then mid-page and abyss captures.
  - Target: under 2 % differing pixels.
  - The header and footer are expected to differ and are noted as such.
- **Behaviour.** A new `e2e/foundations-verify.ts` uses the e2e-harness `boot` / `snap` / `report`
  helpers. It checks:
  - clicking a pill opens a card, the card mounts, and its anchor stays pinned within 2px;
  - clicking again closes it;
  - Harness dims the infra pieces to 0.18, and the reverse;
  - `E` opens all 60 and closes all;
  - the gauge reads "Sea level", then increasing line counts, then the full total at the bottom;
  - every card's autoplay advances while it is visible and stops when it is closed, with no leaked
    timers (the gallery's `live` stat becomes a dev counter);
  - no console errors.
- **Visual pass, card by card.** Open each of the 31 cards in both the app and the prototype gallery
  at the same width, take screenshots, and compare them side by side.
- **Modes.** Check dark and light (the scene is identical in both, and the header stays readable),
  `prefers-reduced-motion`, and a phone at 390px.
- **Checks.** `./singularity check` must pass: type-check, eslint, boundaries, no-hardcoded-colors,
  and plugins-doc-in-sync.
- The app is reviewed at `http://<worktree>.localhost:9000/website/foundations`.

## Risks

- **Scoping the header theme.** Verify this first, and use the `data-over-sky` fallback if it fails.
- **Measured geometry inside a pane.** Offsets are relative to `.iceberg-scene`, not the document.
  Use a ResizeObserver on the scene, plus `fonts.ready`.
- **FLIP on `::after`.** WAAPI `pseudoElement: "::after"` is supported in Chromium and Safari, which
  covers the browsers this page targets.

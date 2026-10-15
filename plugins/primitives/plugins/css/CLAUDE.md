# css

Umbrella for the composable layout primitives — the `<Grid>` / `<Cluster>` /
`<Center>` / `<Overlay>` sub-plugins (and `<Stack>` / `<Row>` for rows) — plus
the lint gate that keeps raw layout CSS out of feature code. Layout is
"CSS-in-semantics": you write the role (a `gallery` grid / a `cluster` of chips /
a row of children), the primitive owns the `flex … min-w-0 shrink-0` mechanics,
so the overlap/clip bug class becomes structurally unrepresentable.

## Enforcement

`lint/no-adhoc-layout.ts` fails `./singularity check` on any class-name carrying
a raw Tailwind layout utility — flow/display (`flex*`, `grid*`, `basis-*`,
`col-span-*`, `row-span-*`), space-sharing (`shrink-*`, `grow-*`, `min-w-0`),
alignment (`items-*`, `justify-*`, `place-*`, `self-*`), positioning
(`absolute`, `fixed`, `sticky`, `inset-*`), and clipping (`overflow-*`). It does
**not** touch positioning *context* (`relative`/`static`), sizing
(`w-*`/`h-*`/`size-*`/`min-w-*` other than the `min-w-0` footgun), or non-flow
display (`block`/`hidden`/`inline`); spacing and `z-*` are owned by their own
rules. Compose layout through the primitives instead — one per mechanic:

| Mechanic | Reach for |
| --- | --- |
| rows / flow | `<Line>` (bare single-line strip) · `<Row>` (interactive row) · `<Stack direction="row">` · `<Cluster>` (wrapping chips) · `<Inline>` (chips mid-sentence) |
| columns / panes | `<Column header body footer>` — rigid \| flexible \| rigid, scrolling body |
| space-sharing | the four roles below · `<Text>` in a line container — THE truncation leaf |
| grids / centring | `<Grid minCellWidth>` · `<Center axis>` |
| overflow | `<Scroll>` (scrolls) · `<Clip>` (clips, no scroll) |
| positioning | `<Overlay>` (in-flow full-bleed layers, as props) · `<Layer>` (ONE standalone `absolute inset-0` child) · `<Pin to>` (point-anchored, offsets on the semantic ramp) · `<Sticky edge>` · `ViewportOverlay` (true `fixed inset-0`) |
| coordinates | `<Placed x y>` (`coords`) — a box placed by **runtime numbers**: Gantt bars, windowed-row offsets, crop rects, editor decorations. `pct(fraction)` writes the `%`. Pin's data-driven sibling |
| padding / gap | `<Inset pad>` · `<Stack gap>` (`spacing`) |

### Space-sharing: two questions, four roles

A flex child answers **does it take slack?** and **does it give below its own
content?** — independently. All four answers have a name; nothing else is legal.

| role | classes | axis? | |
| --- | --- | --- | --- |
| `rigidClass()` / `<Rigid>` | `shrink-0` | no | won't give at all |
| `yieldClass(axis)` | `min-w-0` \| `min-h-0` | **yes** | gives below its content, never takes slack |
| `growClass()` | `flex-1` | no | takes slack, floors at its own content |
| `fillClasses(axis)` / `<Fill>` | `flex-1 min-w-0` | yes | **= grow + yield** (derived, so it cannot drift) |
| *(no class — the default)* | — | — | gives down to its content, takes nothing |

Only `yield`/`fill` take an axis: `min-width:0` and `min-height:0` are two
properties, `flex-shrink`/`flex-grow` are one each and already follow the
container's main axis.

`yield` and `grow` are helper-**only** (no component): they annotate how a box
you already have shares space, so there is nothing to wrap. Two traps worth
knowing — `growClass()` keeps the `min-width:auto` floor, so a `truncate` inside
it is **dead** (you wanted `fillClasses`); and `fillClasses`' basis-0 grow, put
on one of two siblings that must both yield, hands the other its full content
width and squeezes that one alone (you wanted `yieldClass` on both).

A widget that sizes itself from the room it is given cannot be handed that room
by a flag somewhere else, so it **asks**: `useRequestGrow()`
([`grow-relay`](plugins/grow-relay/CLAUDE.md)), and every relaying box between it
and its row grows because it was asked. Not a box you reach for while composing
— `Fill` is — but the reason the slot cell and the reorder wrapper relay, and the
reason no contribution declares `fill: true` for an `AdaptiveBar` any more.

**When you cannot wrap the element** — a third-party `className`-only prop, a
Lexical `<ContentEditable>`, a raw `<img>`/`<svg>`/`<button>` leaf that must
itself be the box — take the class string instead of the component:
`fillClasses(axis)`, `rigidClass()`, `yieldClass(axis)`, `growClass()`,
`layerClasses({layer,decorative})`,
`insetClass(step)`. The question is *do you own the element?* Own it ⇒ the
component; don't ⇒ the helper. Neither supersedes the other, and a raw `<div>` +
`eslint-disable` is not the third answer.

**Hoisting the class string out of the JSX is not an escape.** From a class-name
context the shared walk follows same-file aliases, so `const X = "absolute …"`
and `MAP[key]` are read exactly like an inline literal. Take a named per-site
disable instead — it says *why*, and `lint-directives-stable` keeps it bound to
the code it annotates through any format pass.

The rule's error message carries this same list (hardcoded — lint rules
dual-load under jiti, which cannot resolve `@plugins/*`). The
`css:message-names-primitives` check (`css/check/`) derives the layout-mechanic
set from the `css/plugins/*` directory listing and fails if one is missing from
the message, so a new primitive cannot ship unadvertised.

The exemption manifests is down to **its permanent entries** — the
layout primitives themselves, which own the raw mechanics they redirect to. The
`<Frame>`-era "reverted" tier is drained and empty. **Never add a glob**: new
code is gated immediately, and a genuine one-off escapes per-site via
`// eslint-disable-next-line layout/no-adhoc-layout -- reason`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Umbrella for global CSS layout primitives (named-slot rows, grids, clusters, overlays) with the shrink hierarchy baked into one place.
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
- Exemptions:
  - Exempts itself from: `layout/no-adhoc-layout` — `plugins` (sanctioned)
  - Exempted by:
    - `primitives/adaptive-bar` (0 debt)
    - `primitives/css` (0 debt)
    - `primitives/overlay/cursor-menu` (0 debt)
    - `primitives/overlay/floating-action` (0 debt)
    - `primitives/overlay/surface-overlay` (0 debt)
- Core:
  - Exports (types): `UnanchoredHas`
  - Exports (values): `unanchoredHas`
- Sub-plugins:
  - **`activity-ring`** — Activity ring around a status dot: <ActivityRing state> draws a spinning arc on a faint track while background work runs and a broken destructive ring when it failed; null renders the child alone…
  - **`badge`** — The canonical chip primitive and shared chip shell (region-line single-line core, rigid leading icon, truncating label leaf): semantic variant × colorClass coloring, a rect|pill shape axis, size…
  - **`bouncing-dots`** — Three-dot bouncing activity indicator for 'working'/'pending' states. Renders three animate-bounce dots with staggered delays; size sm (size-1) or md (size-1.5, default).
  - **`card`** — Card chrome primitive (rounded + border + bg + padding) with the Ctrl+A select-scope baked into its root, so cards are a sanctioned home for ad-hoc card markup.
  - **`center`** — Centering layout primitive: <Center axis> centers its content on one or both axes via a grid place-items box.
  - **`clip`** — Clipping layout primitive: <Clip axis fill> hides overflow without scrolling. Sibling of Scroll, kept orthogonal.
  - **`cluster`** — Wrap-friendly chip group layout primitive: <Cluster> lays out a wrapping row of rigid identity chips that never individually shrink, delegating to Stack.
  - **`color-picker`** — Composable color picker primitive: a fitted (always-in-gamut) OKLCH ColorArea, HueSlider, AlphaSlider, per-channel ColorValueFields (HEX / OKLCH / HSL), SwatchGrid with named suggestions, and…
  - **`column`** — Vertical named-slot layout primitive: <Column header body footer> stacks a rigid header, a flexible scrolling body, and a rigid footer in one flex column. Owns the rigid|flexible|rigid fill policy…
  - **`control-panel`** [exempt] — The control-panel vocabulary: ControlPanel plus its closed set of members (Section, Subhead, Row, Setting, Block, Group, RuleList, RuleRow, Field, Footer, Empty, Stack) and its two surfaces…
  - **`control-size`** — Control-size standard: the shared control-* height scale and its enforcing lint rule (no-adhoc-control).
  - **`coords`** — Coordinate-space positioning primitive: <Placed x y> / placedStyle() places a box by runtime numbers on both axes, plus pct() for fractional coordinates.
  - **`fill`** — Flexible-cell layout primitive: <Fill axis> is the single grow+shrink cell of a Line/Row (min-w-0 flex-1). The one home for the slack-absorbing, truncation-enabling cell, so a stray flex-1 never…
  - **`grid`** — Responsive/uniform grid layout primitive: <Grid minCellWidth> lays out a wrapping, equal-width card grid via a closed prop surface — not a raw grid-template passthrough.
  - **`grow`** — Growing-cell layout primitive: growClass() is the flex child that takes the row's slack (flex-1) while staying floored at its own content width. The half of <Fill> that grows, without the half that…
  - **`grow-relay`** — The grow request: a widget that sizes itself from the room it is given asks for that room (useRequestGrow), every box in between relays the ask upward (<GrowRelay>, render-prop), and the row stops…
  - **`icon-auto`** — icon-auto slot-icon sizing convention: the icon-auto @utility (em-based, in app.css) plus the no-adhoc-slot-icon-size lint rule.
  - **`inline`** — Inline-level flow layout primitive: <Inline gap> lays out a baseline-aligned inline-flex row for chips/icons that sit inline in a text run. The inline-level sibling of Stack, delegating to Stack.
  - **`layer`** — Full-bleed layer layout primitive: <Layer> / layerClasses() is a standalone absolute inset-0 child of a positioned parent. The element-shaped sibling of Overlay's behind/above props.
  - **`layout-harness`** — Layout-primitive geometry harness, web half: the bare measurer page and the bun:test geometry suite that measure every geometry-gated exhibit across its width sweep.
    - Plugins:
      - **`geometry`** — Geometry vocabulary of the layout harness, as a types-only leaf: FixtureDims, GeometryInvariant, FixtureMutation, HOST_MARKER_ATTR and GeometrySpec (what an exhibit declares to be geometry-gated).…
  - **`line`** — Single-line container primitive: <Line> pairs the structural single-line invariant (region-line) with the ambient SingleLineProvider so children never wrap and <Text> leaves truncate. The bare…
  - **`link-chip`** — Inline, clickable navigational chip — a clickable Badge drawn as an outlined tile (bg-muted, hairline border, hover:bg-accent) rather than as underlined link text, its label sitting on the baseline…
  - **`overlay`** — In-flow positioning layout primitive: <Overlay behind above clickThrough> paints full-bleed layers under/over its content within its own box, plus the click-through-toggle idiom.
  - **`pin`** — Point-anchored absolute positioning primitive: <Pin to offset> places a child at a corner/edge-center/center of a relative parent. Sibling of Overlay.
  - **`placeholder`** — Muted text placeholder for loading, empty, and error states. Props: children, tone (muted | error).
  - **`radio-group`** [exempt] — Native radio-group control: <RadioGroup options value onChange> mints its own HTML `name` per mount (useId) so two groups on one page are structurally two groups, plus the no-adhoc-radio lint rule…
  - **`radius`** — Corner-radius standard: the token-driven rounded-* scale and its enforcing lint rule (no-adhoc-radius).
  - **`rail`** — Web half of the rail contract: useRailGuard, the dev-only structural guard a region owner attaches to its own box. It measures every child's content edge against the rail the region published and…
  - **`rigid`** — Rigid-leaf layout primitive: <Rigid> / rigidClass() is the flex child that never shrinks (shrink-0). The missing half of <Fill>, kept a sibling the way <Clip> is to <Scroll>.
  - **`row`** [exempt] — Generic interactive row primitive (list, menu, nav, tree, and collapsible section-header rows) with a sanctioned home so ad-hoc rounded+padded interactive markup routes through one primitive.
  - **`scroll`** — Scroll-container layout primitive: <Scroll axis fill> owns overflow AND the flex-child fill policy (min-h-0 flex-1) as one role.
  - **`selection-indicator`** — Presentational checkbox / radio indicator boxes (border + fill + glyph) with the correct preset-independent fixed shape baked in (rounded-checkbox for the checkbox, rounded-full for the radio). The…
  - **`slider`** — Thin-track range slider: a themed range input that normalizes its own fill against (min, max) — so a range other than 0–1 cannot paint a fill that disagrees with its thumb — and owns the optional…
  - **`space-ramp`** — The spacing ramp's one declaration: the closed step set and the literal class each step-keyed @utility family gives each step, generated from app.css so a step that exists in TypeScript but has no…
  - **`spacing`** — Layout spacing primitives: <Stack gap> (flex + gap) and <Inset pad> (padding) draw from the closed density spacing ramp declared in primitives/css/space-ramp, plus insetClass() — the same padding…
  - **`spinner`** — Spinner for loading states: the spinning refresh glyph (default) or, with shape="ring", a thin ring (hover-tone track, current-colour arc). Always spinning by default; spinning={false} pauses.
  - **`status-dot`** — Status-indicator dot primitive: a rounded inline-block span painted either FILLED (colorClass) or as a HOLLOW 1px ring (ringClass), so an empty dot keeps its size in running text as well as in a…
  - **`sticky`** — Sticky positioning layout primitive: <Sticky edge offset layer> pins a header/footer to a scroll edge with a z-layer-aware stacking level; stickyOffsetPx turns a measured height into the exact…
    - Plugins:
      - **`stack`** — Sticky-stack layout primitive: <StickyStack>/<StickyStackItem> pin N sticky siblings sharing one containing block, each below the ones before it (capped; degrades to the swap hand-off).
  - **`surface`** — Semantic surface elevation primitive: <Surface level> bundles background + border + radius + shadow into a closed set of roles (sunken/base/raised/overlay), plus the no-adhoc-surface lint rule.
  - **`switch`** — On/off switch primitive: SwitchIndicator is the presentational track+knob (a span with no role or handler, safe inside something that is already the click target), and Switch wraps it in its own…
  - **`text`** — Semantic typography primitive: <Text variant tone as> picks a frozen size/line-height/weight role from the typography token group (incl. the eyebrow/section-label role). The single sanctioned home…
  - **`theme-boundary`** [exempt] — Theme-boundary primitive: <Theme name surface> is the one element that says 'everything below here wears theme X', complete — the data-theme-scope attribute, the PortalThemeScopeProvider that…
  - **`toggle-chip`** — Toggle-chip control: a stateful pill (composes Badge) in one of three colour treatments — solid (filled when on), ghost (accent fill when on, transparent when off) and tinted (accent wash when on…
  - **`ui-kit`** [exempt] — Global UI kit: the cn() class-merge util, the 14 shadcn/ui primitives, the theme/app.css global stylesheet, and the ControlSize affordance-sizing context.
  - **`viewport-overlay`** — Viewport-filling overlay primitive: self-portals to document.body + z-layer + theme-scope so fixed inset-0 fills the real viewport, never a transformed ancestor. Also owns the runtime auditor for…
  - **`yield`** — Yielding-cell layout primitive: yieldClass(axis) is the flex child that falls below its own content width (min-w-0) but never takes slack. The half of <Fill> that gives, without the half that grows.
  - **`z-layers`** — Semantic z-layer scale (z-base..z-max) and its enforcing lint rule (no-adhoc-zindex).

<!-- AUTOGENERATED:END -->

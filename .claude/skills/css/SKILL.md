---
name: css
description: >
  Map of the CSS/layout mental model and composable layout primitives —
  containers share space, leaves truncate, write the role not the mechanics.
  Read BEFORE any layout, structure, or CSS-composition work.
---

# CSS & Layout

How to compose boxes. For tokens / color / preset and the typography·radius·surface·z-index·control·icon standards, see the [`theme` skill](../theme/SKILL.md). Split: **`css` owns *how to compose boxes*; `theme` owns *tokens & color*.**

## Mental model

> **The spine: every box is exactly one of two things.** A **container** *arranges children* — it declares direction and how slack is shared. A **content leaf** *sizes to itself* — rigid, flexible, or truncating. **Every rule below follows from that split.** Fusing both jobs onto one `<div className="flex … min-w-0 truncate">` (container *and* leaf) is the root of the entire layout-bug class.

Write the role, not the mechanics; let the container own the policy.

- **Space-sharing is a container property, declared once** — never negotiated per child by sprinkling `min-w-0`/`shrink-0`/`flex-1` and hoping it converges.
- **The shrink hierarchy is explicit and total.** For any row that can overflow, "what gives first?" has one answer in one place: rigid identity (chips/icons) never shrinks → secondary metadata truncates first → primary content truncates last.
- **Prefer the layout mode where the bug is unrepresentable.** `rigid | flexible | rigid` is canonical Grid (`auto minmax(0,1fr) auto`); an `auto` track can't collapse under its own rigid content, so "container crushed by its own chip" *cannot* happen. Choose the mode that forbids the bug over the one that merely lets you avoid it.
- **Space-sharing is two independent questions, and all four answers have a name.** *Does the cell take slack?* and *does it give below its own content?* — `Rigid` (`shrink-0`) neither · `yieldClass(axis)` (`min-w-0`) gives only · `growClass()` (`flex-1`) takes only · `Fill` (`min-w-0 flex-1`) both, and is literally derived as grow + yield. No class at all is the fifth, default answer: gives down to its content, takes nothing. Only the `min-*-0` half takes an axis (`min-width:0`/`min-height:0` are two properties; `flex-shrink`/`flex-grow` are one each and follow the container's main axis). `yield`/`grow` ship **no component** — they annotate a box you already have.
  - Two traps the names exist to prevent: `growClass()` keeps the `min-width:auto` floor, so a `truncate` inside it is **dead** (you wanted `Fill`); and `Fill`'s basis-0 grow, put on one of two siblings that must *both* yield, hands the other its full content width and squeezes that one alone (you wanted `yieldClass` on both).
- **`min-width: 0` is a deliberate leaf decision, never a container reflex.** Beyond `yield`/`Fill` above, the truncation leaf (`Text`) carries `min-w-0` so it can ellipsize. (`Scroll`/`Clip` also carry `min-w-0`/`min-h-0` — there as a *flex-basis* fill mechanic, a role that happens to share the class.)
- **Single-line is a property of the CONTAINER, not the text.** The same `<Text>` is correct wrapping in a paragraph and broken wrapping in a row — so whether it truncates is owned by where it lives. **Line containers** (`Row`, `Bar`, collapsible headers, the app tab chip) are single-line by contract: they provide an ambient `SingleLine` context (so every `<Text>` inside ellipsizes on one line) *and* `whitespace-nowrap` (so raw strings/chips don't wrap). That two-layer contract is packaged as the bare **`Line`** primitive (`css/line`) — `Row`/`Bar` compose it, and you reach for it directly for any bespoke single-line strip. **Flow containers** (`Stack` col / `Stack wrap` / `Column` / `Cluster`) RESET both, so text wraps again. There is **no truncation prop on `Text`** — you pick the container, and "non-truncating text in a line row" is unrepresentable. (A plain horizontal `Stack`/`Inline` — row, no `wrap` — is line-ish: it *inherits* the surrounding contract rather than resetting.) The rare forced-single-line case is exactly what `<Line>` is for (or, for just the ambient half without a flex row, `<SingleLineProvider value={true}>` from `…/ui-kit/web`).
- **Group-wrap is a SEPARATE axis from text-wrap.** `whitespace-nowrap` stops *text* wrapping but never `flex-wrap`, so a *group of chips* (a render slot's contributions, a badge cluster) wrapping is owned by container choice: `Cluster` wraps, `Inline`/`Row` stay one line. A multi-contribution chip slot must be wrapped in `Inline`/`Cluster` — a bare `.Render` adds no container, so the chips wrap by default.
- **Where a slot's items sit is config, not code.** To put some of a render slot's contributions at the far end of its row (title left, chips right), add a `{ "type": "spacer", "id": "<unique-id>" }` node to the slot's order file (`config/<plugin>/<slot>.jsonc`, legend at its top) — it grows and pushes everything after it to the end. **Never** define a second slot for "the ones on the right": that freezes the split in code, moves every contributor, and a user can no longer drag an item across it. Lint: `spacer/no-split-slot-row`. A second slot is right only when the groups are different *kinds* of thing (different item props or owners), not the same kind at another position.
- **Semantic intent over mechanics.** Write `content` / `meta` / `stack with sm rhythm`; the primitive owns `flex items-center gap-2 min-w-0 …` and can fix it once, globally. Same "CSS-in-semantics" philosophy as `spacing`/`text`/`surface`.
- **Size is a region property, not a per-element prop.** Same "container owns the policy" rule applied to control density: a control's size (height·text·padding·icon) is inherited from the ambient `ControlSize` a container declares **once** (`ControlSizeProvider`, or a slot's `controlSize`) — never set per instance. `Badge` / `ToggleChip` / `SegmentedControl`, the icon buttons, and **`Button`** all derive density *solely* from context (no `size` prop anywhere; passing one is a compile error). `Button` is the last control that used to hold out — that escape hatch is gone. `Button`'s **shape** (text / icon / inline) is a separate `aspect` prop and carries no density. Full model in the [`theme` skill](../theme/SKILL.md).

### Worked example — a header row that won't overlap

```tsx
// WRONG — container + leaf fused onto every div; the bug cascades forever
<div className="flex items-center gap-2 min-w-0">
  <Icon />
  <span className="flex-1 truncate">{title}</span>   {/* no min-w-0 → truncate is dead */}
  <RelativeTime date={t} />
  <div className="absolute right-2"><Actions /></div> {/* pr-hint only → floats over title */}
</div>

// RIGHT — Line is a single-line container; one Fill holds the truncating leaf; each box has one job
<Line>
  <Icon />                            {/* rigid leaf, never crushed */}
  <Fill>
    <Text>{title}</Text>             {/* the ONE grow cell; Text truncates under pressure,
                                          and is block-level so the cell is exactly as
                                          tall as its text and the Icon centres on it */}
  </Fill>
  <RelativeTime date={t} />          {/* rigid meta, sits in its own track */}
  <Actions />                        {/* rigid trailing — a real track, never absolute */}
</Line>
```

## The overlap bug class (read before hand-rolling any row)

Two boxes overlap when one lands in a region the layout engine never reserved
*for it* — because the boundary was a **hint the content can ignore**, not a real
track. Two recurring shapes, both fixed by a grid track / clip:

- **Absolute trailing indicator + reservation padding.** `relative flex … pr-2xl`
  with a trailing checkmark/badge `absolute right-2`. The `pr-2xl` is only a hint;
  a `flex-1`/`shrink-0` label grows under the floating indicator. → Give the
  trailing affordance a real track: a rigid leaf after an empty `<Fill>` (the
  `Fill` absorbs the slack, the leaf sits flush-right in its own track), or drop
  to inline `grid-cols-[minmax(0,1fr)_auto]`. Never `absolute` +
  padding-reservation for a trailing affordance.
- **Rigid leaf in an unclipped flexible cell.** A `flex-1 min-w-0` cell with **no
  overflow clip** holding a `shrink-0` child (a `SegmentedControl`, a fixed
  control): when narrow the child overflows onto the next sibling. → The cell must
  own its overflow (`Clip`) or the child must be allowed to yield. Also: `flex-1
  truncate` **without** `min-w-0` never shrinks (implicit `min-width:auto`) — the
  `truncate` is dead; always `min-w-0 flex-1 truncate`.

**Layer rule — no feature code re-derives flex+absolute row layout by hand.**
Compose the row from a line container (`Line`/`Row`/`Bar`) + `Fill` + rigid
leaves, so the affordance is a sibling leaf in a real track. Only the lowest
primitives that can't reach for `Fill` — e.g. `ui-kit`'s shadcn menu items, where
the import would cycle — write the grid tracks directly, with a named
`eslint-disable`. Either way the indicator/affordance lives in a track, never
floats over the label.

## Who owns the inset (the rail contract)

**Applying inline padding is the act of opening a region, not decorating a box.** A box either *opens* a region — declares where its contents' left edge is — or *lives* in one and does nothing. There is no third thing, so "both applied it" is what *opened a region without meaning to* looks like from outside. Nothing looks wrong at either call site; the only evidence is content indented twice. Full model: [`css/rail`](../../../plugins/primitives/plugins/css/plugins/rail/CLAUDE.md).

A region publishes what it did, so a descendant has a number to read: `--rail-start`/`--rail-end` = **the inset already applied** (what a bleed cancels), `--rail-owed-start`/`--rail-owed-end` = **the inset a follower must still apply itself**. Three utilities, and you want exactly one of them:

- **`rail-<step>`** (`rail-x-` / `rail-y-` are the single-axis members, mirroring `p`/`px`/`py`) — **open a region**: pad AND publish in one declaration, so the number exists once. Sets owed to `0px` — the owner paid. This is what a host that insets a `DataView`, a card body, or a panel reaches for.
- **`rail-bleed`** — **the only escape**, for a child that must reach the region's inner edge (a row whose hover fill reads as a row, a hairline spanning the panel). Cancel and re-apply are ONE class because half of it is the entire bug: cancel without re-applying and the content moves, re-apply without cancelling and it moves twice.
- **`rail-follow`** — **pay what is owed** without opening a region, for the inverted topology where the container deliberately does not pad and each band insets itself (`data-view`'s toolbar / bodies / group headers). Under a paying owner it adds nothing, which is what stops a band double-insetting.

`rail-owe-<step>` is the fourth and rarest: publish a region and pay none of it, leaving every `rail-follow` band inside to apply it (the app-shell sidebar).

```tsx
// WRONG — Inset pads without publishing, so the rail class announces a number
// nothing applied; every follower inside then guesses, and the ones that guess
// right do so by coincidence.
<Inset pad="lg" className="rail-x-lg"><DataView … /></Inset>

// WRONG — a hand-published rail on a box that ALSO pads: `--rail-owed-*` falls
// back to the rail, so each band inside pays a second time. 24px becomes 48.
<div className="px-lg" style={{ "--rail-start": "var(--space-lg)" }}>…</div>

// RIGHT — one declaration, one number. The bands follow it and add nothing.
<div className="rail-x-lg"><DataView … /></div>
```

Never `Inset` + a rail class on one box, and never publish `--rail-start` by hand without also setting `--rail-owed-*`. Enforcement is the layout harness's **region fixtures** — a fixture says only "this box opens a region" and the harness supplies the children, so a region cannot be gated against the child kind it already handles — plus `useRailGuard` (`css/rail/web`), the dev-only guard a region owner attaches to name any child that lands off the rail.

## Layout primitives

Reach for these instead of raw flex/grid. Import from `@plugins/primitives/plugins/<name>/web` (the `css/*` layout primitives live under `@plugins/primitives/plugins/css/plugins/<name>/web`). Shared conventions mirror `Stack`: `gap: SpaceStep` (from `css/space-ramp/core`, the ramp's one declaration — `none 2xs xs xsm sm smd md lg xl 2xl`, comfortable 0/2/4/6/8/10/12/16/24/32px, where `xsm`/`smd` are derived midpoints of their neighbours; never re-spell the steps or build a `gap-${step}` string), reused `StackAlign`/`StackJustify`, `as?`, `className` last. **All accept `ref?: React.Ref<HTMLElement>`** (React-19 ref-as-prop) — pass `<Scroll ref={sticky.scrollRef}>` for auto-scroll / sticky-scroll / ResizeObserver / scroll-into-view; never fall back to a raw `<div ref=…>` + eslint-disable just to attach a ref.

**When you cannot wrap the element, take the class string — not a raw `<div>` + disable.** `fillClasses(axis)` (`css/fill`), `rigidClass()` (`css/rigid`), `layerClasses({layer,decorative})` (`css/layer`), `placedStyle(x, y)` (`css/coords`, a style object) and `insetClass({pad,…})` (`spacing`) are the same resolvers their components use, returned as a class string, for a third-party component's `className`-only prop, Lexical's `<ContentEditable>`, or a raw `<img>`/`<svg>`/`<textarea>`/`<button>` leaf that must itself be the box. `yieldClass(axis)` (`css/yield`), `growClass()` (`css/grow`) and `selfClass(align)` (`spacing`) are class-string-only by design — there is no component, because they annotate a box you already have. **`selfClass` is helper-only for a stronger reason than the others**: it is ONE child's cross-axis override (the mirror of a container's `align`, keyed by the same `StackAlign`), and a `<Self>` wrapper would *become* the flex item — the alignment would land on the wrapper and the real child would stretch inside it. Wrapping doesn't just add a box; it breaks the mechanic.

> **The boundary: do you own the element?** Own it ⇒ the component (polymorphic `as` retargets the host element while keeping the primitive). Don't own it ⇒ the class helper. Neither supersedes the other, and hand-writing the mechanics under an `eslint-disable` is not a third answer.

**Pick a container:** single-line chrome row → `Line`/`Row` + `Fill` · sticky-header / scroll-body / footer surface → `Column` · card grid → `Grid` · wrapping chips/tags → `Cluster` · chips mid-sentence → `Inline` · just center something → `Center` · plain stack of blocks with rhythm → `Stack` (+ `Inset` for padding). Then surfaces (`Card`/`Surface`/`Bar`) sit *inside* structure, leaves (`Text`/`Badge`) *inside* those: structure → surface → leaf, outside-in. **A list of domain records is not a container choice at all** — it's a [`DataView`](../../../plugins/primitives/plugins/data-view/CLAUDE.md) (`data-view/no-adhoc-row-list` bans `.map()`→`<Row>`); `Row`+map is only for transient chrome (menus, pickers, tab strips) with a named disable.

**Defaults differ — check, don't assume:** `gap` is *required* on `Stack`/`Inline`, but `none` on `Column`, `sm` on `Cluster`, `md` on `Grid`. `as` defaults to `div` everywhere *except* `Inline`/`Text` (`span`) and `Bar` (`header`).

- **`Stack` / `Inset`** (`spacing`) — 1-D flow container (dir·gap·align·justify·wrap) · padding container. The home for layout rhythm. **There are no margins**: space between boxes is the container's gap, never a child's `mt-*`/`ml-*` (the spacing CLAUDE.md maps every kind of margin to its replacement). `<FirstLine>` (same plugin) seats a leading icon on a wrapping text's first line. → [CLAUDE.md](../../../plugins/primitives/plugins/css/plugins/spacing/CLAUDE.md)
- **`Fill`** (`css/fill`) — the single grow+shrink cell of a line row: owns the `min-w-0 flex-1` pair (the one sanctioned home). Pair it with a line container (`Line`/`Row`/`Bar`) — the rigid chips stay put, and the ONE `<Fill>` holds the `<Text>` that truncates under pressure. An **empty** `<Fill>` pushes trailing actions flush-right (the structural replacement for `ml-auto`). This row-level `rigid | flexible | rigid` composition keeps overlapping/overflowing header rows unrepresentable.
- **`GrowRelay`** (`css/grow-relay`) — not a box: the **grow request**. A widget that sizes itself from the room it is given (`AdaptiveBar`) calls `useRequestGrow()`, and every relaying box between it and its row grows because it was asked — the slot cell, the reorder edit-mode wrapper (`Fill` is not one: it grows already, and context crosses it for free). `Line`/`Row`/`Bar` stop the ask. You reach for it only when you own a wrapper box between a row and such a widget; it replaced a `fill: true` that lived on a contribution three files from the bar it was about. → [CLAUDE.md](../../../plugins/primitives/plugins/css/plugins/grow-relay/CLAUDE.md)
- **`yieldClass(axis)`** (`css/yield`) — the cell that gives below its own content (`min-w-0`/`min-h-0`) and never takes slack. **Class helper only, no component** — every site annotates a box it already owns. Reach for it when a `<Text>`/`FilePath` inside must ellipsize but the box must not grow: two siblings that must yield *together* both take it, where a `Fill` on one would squeeze that one alone.
- **`growClass()`** (`css/grow`) — the cell that takes the row's slack (`flex-1`) while staying floored at its own content, so its leaves never truncate (a chip strip that hugs its content while only the trailing gap grows; an `<input>` that fills the row). **Class helper only**, no axis. A `truncate` inside it is dead — that case is `Fill`. With no content at all (spacer, hairline, coordinate track) the two are identical: use `Fill`.
- **`Rigid`** (`css/rigid`) — the other half of `Fill`: the flex child that never shrinks (`shrink-0`). **No axis prop** — `flex-shrink` already follows whichever axis the container declared as main, unlike Fill's `min-w-0`/`min-h-0`, which are two distinct properties. `rigidClass()` is the usual answer (most sites already own an element they style); `<Rigid>` is for a content-less rigid spacer (`<Rigid className="w-16"/>`) or a wrapper you can't otherwise reach.
- **`Column`** (`css/column`) — named-slot **column** (the vertical `rigid | flexible | rigid` primitive), **slots-as-props** (no children): `header` (rigid) · `body` (flexible, scrolls by default) · `footer` (rigid). Bakes the `rigid | flexible | rigid` fill policy — `shrink-0` header/footer, body delegated to `<Scroll fill>` — so sticky-header / scroll-body / footer surfaces (panels, panes, dialogs) never re-derive `min-h-0 flex-1 overflow-y-auto` by hand. `scrollBody={false}` for a plain flexible body; `fill` to fill a flex-col parent (e.g. inside a `FloatingAction` morph panel).
- **`Grid`** (`css/grid`) — responsive/uniform card grid via closed `minCellWidth` + `mode: fill|fit` (or fixed `cols`). **Not** a raw `grid-template` passthrough; the rigid|flex|rigid row case is `Line`/`Row` + `Fill`'s job.
- **`Cluster`** (`css/cluster`) — wrap-friendly group of rigid chips/tags. Thin `Stack` row+wrap specialization (chips wrap, never crush).
- **`Center`** (`css/center`) — centering box (`grid place-items`), `axis: both|horizontal|vertical`.
- **`Overlay`** (`css/overlay`) — in-flow positioning: `behind`/`above` full-bleed layers (z-layer-aware) + `clickThrough` with `Overlay.Interactive` opt-in (the sanctioned home for the click-through-toggle idiom). Pairs with `ViewportOverlay` (which portals to body for true `fixed inset-0`).
- **`Layer`** (`css/layer`) — ONE standalone full-bleed `absolute inset-0` child of a positioned parent: `layer` (`InTreeLayer`, default `base`), `decorative` (`pointer-events-none`). Reach for it where `Overlay` cannot go — Overlay takes its layers as *props* around required in-flow `children`, so it can't express a layer that IS an element (a full-bleed `<img>`/`<svg>`), a bare sibling in a list of layers, or a backdrop that is itself the positioning host. Full-bleed only (no partial inset — that's `Pin`). Defaults live in `layerClasses()`, not the component.
- **`Scroll`** (`css/scroll`) — scroll-container box: owns overflow + the flex-child fill policy as one role. `axis: y|x|both`, `fill` (`min-h-0 flex-1`), `hideScrollbar`, `isolate`. Sizing (`h-*`/`max-h-*`) stays in `className`. The home for `min-h-0 flex-1 overflow-y-auto`.
- **`Clip`** (`css/clip`) — clipped, non-scrolling overflow (`overflow-hidden`); sibling of Scroll. `axis: both|x|y`, `fill`. **Not** for text truncation (that's `Text` inside a line container); `rounded-*`/`border` stay in `className`.
- **`Sticky`** (`css/sticky`) — sticky header/footer: `edge: top|bottom|left|right`, `offset: SpaceStep`, z-layer-aware `layer`. The home for `sticky top-0 z-raised`; `bg-*`/`border-*` stay in `className`.
- **`Pin`** (`css/pin`) — point-anchored absolute child of a `relative` parent (sibling of Overlay, not full-bleed): `to` (9 anchors: corners·edge-centers·center), `offset`/`outset`, `layer`, `decorative`, `stretch`, `spanOffset`. The home for `absolute top-1 right-1`. Offsets come from the **semantic ramp**; runtime numbers are `<Placed>`. `stretch`/`spanOffset` are edge-center anchors only — a *type error* on a corner or `center`, via a generic over `to` (not a props union, which couldn't accept a union-typed `to`). `spanOffset` insets the spanned axis from **both** its edges (the DnD drop-indicator bar) and implies `stretch`; `outset` never negates it, `mask` forces it to `0`.
- **`Placed`** (`css/coords`) — the box placed by **runtime numbers**: `x`/`y` extents (`fill` · `{start,size,minSize}` · `{end,…}` · `{start,end}` · `{center}`, each with an optional `shift`), `layer`, `decorative`; `pct(fraction)` writes the `%`. Gantt bars, windowed-row offsets, crop rects, DOMRect highlights, editor decorations. **Both axes are required** — omitting one leaves the CSS *static position*, the one genuinely surprising outcome. Over-specifying an axis is a tsc error. It writes the CSS `translate` property and **never** `transform`, so a per-frame ref writer that owns `transform` composes with it instead of fighting it. There is **no `<Plane>`**: the host is `<Layer>`, `<Clip>`+`growClass()`, or any `relative` box. Not for `position: fixed` (that's `ViewportOverlay`/`cursor-menu`).
- **`Text`** (`css/text`) — **the** truncation leaf (and the typography primitive). Inside a **line container** it single-lines + ellipsizes automatically via the ambient `SingleLine` context (it owns the `min-w-0 + truncate` recipe); inside a **flow container** it wraps. The truncating leaf is **block-level and shrink-to-fit**, so a `Fill` cell holding it is exactly as tall as its text and the row's icon centres on the words rather than ~3px below them (an inline-level box with `overflow:hidden` makes its parent reserve a phantom descender). `side="start"` ellipsizes the lead (file paths); no truncation on/off prop — pick the container. → [CLAUDE.md](../../../plugins/primitives/plugins/css/plugins/text/CLAUDE.md)
- **`Line`** (`css/line`) — the bare **line-container** primitive: `flex region-line` + the ambient `SingleLine` context, no chrome. The sanctioned home for a single-line row where raw strings/chips don't wrap and `<Text>` leaves ellipsize. `Row`/`Bar` compose it; reach for it directly for a bespoke single-line strip (a tab chip, a card header) that isn't a full `Row`/`Bar`. `Badge` stays `inline-flex` (the inline case) and doesn't compose it. → [CLAUDE.md](../../../plugins/primitives/plugins/css/plugins/line/CLAUDE.md)
- **`Row` / `SectionHeaderRow`** (`row`) — interactive row (list·menu·nav·tree·section-header). A `.map()` of domain records into `Row` is banned (`data-view/no-adhoc-row-list`) — that's a `DataView`. → [CLAUDE.md](../../../plugins/primitives/plugins/css/plugins/row/CLAUDE.md)
- **`Surface`** (`surface`) — elevation roles (sunken·base·raised·overlay). → [CLAUDE.md](../../../plugins/primitives/plugins/css/plugins/surface/CLAUDE.md)
- **`Card`** (`card`) — raised + padded chrome. → [CLAUDE.md](../../../plugins/primitives/plugins/css/plugins/card/CLAUDE.md)
- **`ViewportOverlay`** (`viewport-overlay`) — portals to body for true `fixed inset-0` + z-layer + theme-scope. → [CLAUDE.md](../../../plugins/primitives/plugins/css/plugins/viewport-overlay/CLAUDE.md)
- **`AdaptiveBar`** (`adaptive-bar`) — a single-line bar that fits its children by asking each for a smaller form of itself, then **moving** (never re-rendering) the rest into a panel behind a `⋯`. Must be the growing cell of its row. → [CLAUDE.md](../../../plugins/primitives/plugins/adaptive-bar/CLAUDE.md)

The full audit — every primitive's exact API, composition recipes, the defaults table, and known rough edges — is the [CSS primitives audit](../../../research/2026-06-20-css-primitives-audit.md). Design rationale + track mechanics for the original `css/*` primitives are frozen in [the API spec](../../../research/2026-06-15-global-css-layout-primitive-apis.md); the roadmap is in [the vision doc](../../../research/2026-06-15-global-css-layout-primitives-vision.md). The Scroll/Clip/Sticky/Pin set (closing the scroll/clip/sticky/positioning gaps) is specified in the [allowlist-drain plan](../../../research/2026-06-17-global-drain-no-adhoc-layout-allowlist.md).

## Enforcement

Principle: **no raw layout utilities in feature code** — one escape valve, always with a named reason: `// eslint-disable-next-line layout/no-adhoc-layout -- <reason>`.

The `no-adhoc-layout` rule (`plugins/primitives/plugins/css/lint/`, registered repo-wide as `error`) bans raw flow/display (`flex*`, `grid*`, `basis-*`, `col-span-*`, `row-span-*`), space-sharing (`shrink-*`, `grow-*`, `min-w-0`), alignment (`items-*`, `justify-*`, `place-*`, `self-*`), positioning (`absolute`, `fixed`, `sticky`, `inset-*`), and clipping (`overflow-*`). Deliberately **not** banned: positioning *context* (`relative`/`static`), sizing (`w-*`/`h-*`/`size-*`/`min-w-*` other than `min-w-0`), and non-flow display (`block`/`hidden`/`inline`). Spacing (`gap-*`/`p-*`/`m-*`) and `z-*` are owned by their own rules, so this one stays out of their lane.

The rule's error message names every primitive above, grouped by mechanic, plus the class-string escape — so the answer arrives with the error. It is hardcoded (lint rules dual-load under jiti, which can't resolve `@plugins/*`) and guarded by the `css:message-names-primitives` check, which derives the layout set from the `css/plugins/*` directory listing.

The allowlist in `css/lint/index.ts` is down to **5 permanent globs** — the layout primitives themselves (`css/plugins/**`, `floating-action`, `cursor-menu`, `surface-overlay`, `adaptive-bar`), which own the raw mechanics the rule redirects to. The `<Frame>`-era "reverted" tier is fully drained and empty, so there is no longer any allowlisted feature code: every remaining raw-layout site carries a named per-site disable and is visible to grep. **Never add a new glob** — new code is gated immediately, and a genuine one-off escapes per-site with a named disable. The other token/standard rules (typography, radius, surface, z-index, control, icon) are listed in the [`theme` skill](../theme/SKILL.md).

---
If something was missing from this skill, report it (`add_task` or tell the user) so it gets added.

# Layout Primitive Set — API Design

> **Status:** Spec. Designs the prop surfaces of the minimal layout-primitive set
> from [the vision doc](./2026-06-15-global-css-layout-primitives-vision.md) (Phase 0,
> "design the minimal primitive set's APIs"). Building each primitive, the
> `no-adhoc-layout` lint rule, and the `css/` directory extraction are the
> separate downstream tasks the vision enumerates — **not** in scope here.

## Context

Layout is the one design dimension in this codebase with no semantic primitive and
no enforcement. Raw flex/grid/positioning utilities appear ~1,640× across ~430
files, each call site re-deriving a global space-sharing negotiation by hand. The
`CollapsibleCard` header (`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web/components/collapsible-card.tsx:62-122`)
is the canonical victim: every fix trades one symptom (chips wrapping → path
overflowing → badge overlapping path) for the next, because **container policy and
leaf truncation are fused onto the same `<div className="flex … min-w-0 truncate">`.**

The cure already exists for every *other* dimension: nine `no-adhoc-*` primitives
(spacing, radius, typography, surface, …) redirect raw utilities to closed semantic
roles. This spec extends that proven model to layout by defining the **API surface**
of the new set, mirroring the existing `Stack`/`Inset`/`Bar`/`TruncatingText`
precedent byte-for-byte where it applies.

**Intended outcome:** a set of prop surfaces such that the `CollapsibleCard` bug
class is structurally unrepresentable — containers own space-sharing, leaves own
truncation, and callers write *roles* (`leading`/`content`/`meta`) not *mechanics*
(`flex-1 min-w-0 shrink-0`).

## Decisions locked with the user

1. **Frame uses slots-as-props**, not compound subcomponents. Each slot maps to a
   fixed grid track; a child physically cannot land in the wrong shrink role. No
   `children`.
2. **Cluster and Center are thin specializations** of `Stack` — distinct exports
   (named for intent, the future home for chip-overflow / centering policy) that
   delegate internally rather than reimplement.
3. **Deliverable is this spec only.** Implementation, lint rule, and directory move
   are downstream tasks.

## Shared conventions (mirror existing precedent)

Every primitive follows the `Stack`/`Inset`/`Bar` shape so the set reads as one family:

- **`gap`/`pad` draw from `SpaceStep`** (`none|2xs|xs|sm|md|lg|xl|2xl`), imported from
  `@plugins/primitives/plugins/spacing/web`. Never a raw `gap-2`.
- **Reuse `StackAlign` / `StackJustify`** for cross/main-axis props — do **not**
  redefine align/justify enums. Import the types from `spacing/web`.
- **`as?: ElementType`** on every primitive; defaults to the semantically-correct tag.
- **`className` composes last** (caller override wins), exactly like `Stack`/`Bar`.
  - *On the vision's warning that a `className` passthrough lets callers reintroduce
    `min-w-0` at the wrong altitude:* we keep `className` (needed for width, color,
    `mx-auto`, etc.) and rely on the **`no-adhoc-layout` lint rule** (next phase) to
    reject raw layout utilities *in the className string at the call site*. Removing
    `className` would break consistency with every existing primitive and is not the
    real guard — the lint rule is. This split is deliberate and stated here so the
    build task doesn't "harden" by dropping `className`.
- **Each is its own sub-plugin** (per the modularity convention), barrel-only
  `index.ts`, component in `web/internal/`.

---

## 1. `Frame` — the named-slot row (the star)

The structural fix for the `CollapsibleCard` class. A horizontal row of up to four
**role slots** with the shrink hierarchy baked in one place.

```tsx
export type FrameAlign = "center" | "start" | "baseline"; // subset of StackAlign

export interface FrameProps {
  /** Rigid leading cluster — never shrinks (chevron, icon, identity badge).
   *  Multiple children are laid out as an internal rigid cluster. */
  leading?: ReactNode;
  /** Primary content — truncates LAST. If a string, auto-wrapped in the truncation
   *  leaf; if a node, placed in a `min-w-0` flexible track (caller puts a
   *  <TruncatingText> around the text that should ellipsize). */
  content?: ReactNode;
  /** Secondary metadata — truncates FIRST (file path, timestamp, count).
   *  Same string/node treatment as `content`. */
  meta?: ReactNode;
  /** Rigid trailing cluster, right-aligned — never shrinks (actions, status). */
  trailing?: ReactNode;
  /** Inter-slot gap from the ramp. Default `sm`. */
  gap?: SpaceStep;
  /** Cross-axis alignment. Default `center`. */
  align?: FrameAlign;
  as?: ElementType;     // default "div"
  className?: string;
}
```

**Why slots-as-props, no `children`:** the four roles *are* the API. You cannot
forget `min-w-0`, cannot put a chip in the truncating track, cannot fuse container +
leaf. The bug is unrepresentable by construction.

**Implementation = CSS Grid** (the mode where the bug can't happen — vision Part 1.4):

```
grid-template-columns: auto  minmax(0, 1fr)  minmax(0, auto)  auto
                       leading   content          meta       trailing
```

- `leading` / `trailing`: `auto` tracks — collapse to 0 when the slot is absent,
  and **cannot be crushed below their rigid content** (no "container collapsed under
  its own chip").
- `content`: `minmax(0, 1fr)` — absorbs slack, min 0 so an inner truncation leaf
  ellipsizes. Truncates last.
- `meta`: `minmax(0, auto)` — sizes to content, shrinks to 0 first.

> **Shrink-priority caveat (for the build task, not decided here):** strict
> "meta hits 0 before content gives up a pixel" is *not* guaranteed by the naive
> `minmax(0,1fr) minmax(0,auto)` pair under all width ratios — grid distributes the
> overflow deficit across both shrinkable tracks. The build task must validate the
> exact track functions against the geometry matrix `{short,long} content ×
> {with,without} meta × {narrow,wide}` (the same bounding-box test that caught the
> original 11.3px overlap) and adjust (e.g. a `meta`-capping `max-content` or a
> documented `fr` weighting) until the priority holds. The **API above is stable**
> regardless of which track function wins.

**Internal slot wrapping (caller never sees it):**
- `leading`/`trailing` → rigid cluster (`flex items-center` + gap, `shrink-0` via the
  `auto` track).
- `content`/`meta` → `min-w-0` flexible track; if the prop is a `string`, Frame wraps
  it in `<TruncatingText>` itself (convenience mirroring TruncatingText's own
  string→title auto-derive). Node values get the bare `min-w-0` track and the caller
  composes the leaf where needed (so chip+text labels keep chips whole — the exact
  thing `collapsed-card.tsx:99-106` hand-rolls).

**Closes:** `CollapsibleCard`'s `HEADER` row migrates to `<Frame leading={chevron+badge}
content={label} meta={<FilePath/>} trailing={<RowActions/>} />` (a Phase-1 task). The
click-through toggle behind it is handled by `Overlay` (§5).

---

## 2. `Grid` — responsive / uniform grid

The structural "rigid | flexible | rigid" case is now **Frame's** job, so `Grid`
focuses on the remaining concern with no other home: the **responsive card grid**
(galleries, launcher grids — cf. `data-view/gallery`). It is a *closed* prop surface,
**not** a raw `grid-template` passthrough (that genuine long-tail stays an
`eslint-disable … -- <reason>` exception).

```tsx
export interface GridProps {
  /** Minimum width each cell wants before the row wraps to fewer columns.
   *  Drives `repeat(auto-fill|fit, minmax(<minCellWidth>, 1fr))`. e.g. "12rem". */
  minCellWidth: string;
  /** `fill` keeps empty trailing tracks (stable column count); `fit` collapses
   *  them so present cells stretch. Default `fill`. */
  mode?: "fill" | "fit";
  /** Fixed column count instead of responsive (mutually exclusive with the
   *  responsive `minCellWidth`/`mode` path; pass one or the other). */
  cols?: number;
  /** Gap between cells, from the ramp. Default `md`. */
  gap?: SpaceStep;
  align?: StackAlign;    // align-items within each cell
  justify?: StackJustify; // justify-items / content
  as?: ElementType;       // default "div"
  className?: string;
  children?: ReactNode;
}
```

**Why no `columns: string` escape:** an arbitrary template string *is* the raw CSS we
ban. The two real needs are covered: structural rigid|flex|rigid → `Frame`; uniform
responsive grid → `Grid`. Anything else is rare enough for the lint escape valve.

---

## 3. `Cluster` — wrap-friendly chip group

A horizontal group of **rigid** chips/tags that wrap to the next line. Distinct
export for intent + as the future home for chip-overflow policy (it can later compose
`ResponsiveOverflow` with zero call-site change); **delegates to `Stack` internally.**

```tsx
export interface ClusterProps {
  /** Gap on both axes (wrap rows + chips), from the ramp. Default `sm`. */
  gap?: SpaceStep;
  align?: StackAlign;     // default "center"
  justify?: StackJustify;
  as?: ElementType;       // default "div"
  className?: string;
  children?: ReactNode;
}
```

Internally: `<Stack direction="row" wrap align={align} justify={justify} gap={gap}>`.
The semantic contract Cluster adds over a bare Stack: **children are identity chips —
rigid, wrapping, never individually shrinking.** (Implementation note: children are
expected to be `shrink-0` by nature; Cluster does not impose `min-w-0` anywhere.)

---

## 4. `Center` — centering

The other ubiquitous one-liner. Thin specialization; implemented as
`grid place-items-center` (centers both axes in one declaration, no flex
child-stretch surprises).

```tsx
export interface CenterProps {
  /** Which axes to center. Default `both`. */
  axis?: "both" | "horizontal" | "vertical";
  as?: ElementType;       // default "div"
  className?: string;
  children?: ReactNode;
}
```

Scope is deliberately just the **flex/grid centering box**. `mx-auto`/`my-auto`
(centering a constrained block) is already allowed by the spacing rules and needs no
primitive — keep Center to the `place-items-center` case so the set stays orthogonal.

---

## 5. `Overlay` — sanctioned in-flow positioning

Establishes a positioning context and paints a **full-bleed layer** (`absolute
inset-0`, z-layer-aware) behind or above its in-flow content. Folds in the
click-through-toggle idiom `CollapsibleCard` hand-rolls today (`collapsible-card.tsx:85-121`).
Pairs with — does **not** replace — `viewport-overlay` (which portals to `<body>` for
true `fixed inset-0`); `Overlay` is for positioning *within* a box.

```tsx
export interface OverlayProps {
  /** Full-bleed layer filling the box (absolute inset-0), painted BEHIND `children`.
   *  Typically a click target (a toggle button) or a background. */
  behind?: ReactNode;
  /** Full-bleed layer painted ABOVE `children` (badges, hover scrims, gradients). */
  above?: ReactNode;
  /** In-flow content; establishes the box's natural size. */
  children: ReactNode;
  /** z-layer for the painted layers, from the z-layers scale. Default `z-base`. */
  layer?: ZLayer;
  /** When `behind` is a click target, set true so `children` are click-through
   *  (pointer-events-none) and clicks reach `behind`. Interactive bits inside
   *  `children` opt back in with <Overlay.Interactive>. Default false. */
  clickThrough?: boolean;
  as?: ElementType;       // default "div"
  className?: string;
}

/** The pointer-events-auto + relative opt-in for interactive content sitting over a
 *  `clickThrough` layer. Replaces the bespoke `CardHeaderAction` pair. */
export function OverlayInteractive(props: { children: ReactNode; className?: string }): JSX.Element;
// exported as Overlay.Interactive
```

**Maps the `CollapsibleCard` pattern exactly:** the toggle button becomes
`behind={<button …/>}`, the header content becomes `children` with `clickThrough`, and
each interactive sibling (FilePath, RowActions) wraps in `<Overlay.Interactive>`
instead of the hand-rolled `pointer-events-auto relative` (`CardHeaderAction`). The
header row *inside* is a `<Frame>` — Frame and Overlay compose.

---

## 6. `Truncate` — the mandatory truncation leaf

Already exists as **`TruncatingText`** (`plugins/primitives/plugins/truncating-text`).
It already owns the `min-w-0 + truncate` pair — promote it (in the `css` skill) to
*the* sanctioned truncation leaf; every flexible label in a Frame `content`/`meta`
slot is a `TruncatingText` (or Frame's string auto-wrap).

**One additive API change** (orthogonal, covers the raw `line-clamp-*` long tail):

```tsx
export interface TruncatingTextProps {
  children: ReactNode;
  /** Truncate to N lines (line-clamp) instead of a single line. Default 1. */
  lines?: number;        // NEW
  as?: ElementType;
  className?: string;
  title?: string;
}
```

`lines={1}` keeps today's `min-w-0 truncate`; `lines>1` switches to
`min-w-0 line-clamp-<n>`. No rename needed — the `css` skill can document it as "the
truncation leaf (a.k.a. Truncate)". An optional `export { TruncatingText as Truncate }`
alias is a nice-to-have for discoverability, decided at build time.

---

## Directory placement (recommendation, finalized in the build task)

The vision's Phase 3 creates `plugins/primitives/plugins/css/` and *moves* existing
plugins into it. To avoid building these five only to move them immediately, the
build tasks should create the new primitives **already nested** under their final
home, each its own sub-plugin:

```
plugins/primitives/plugins/css/plugins/{frame,grid,cluster,center,overlay}/
```

`truncating-text` and `spacing` migrate into the same `css/` umbrella later (Phase 3),
zero API change. Plugin IDs + registries auto-regenerate from path; boundary config
(`plugin.** -> plugin.**`) needs no change. **This is a placement recommendation, not
part of the API contract** — the prop surfaces above are identical wherever the files
land.

## Cross-primitive composition (the proof the set is complete)

The original bug's row, expressed in the new set:

```tsx
<Overlay clickThrough behind={<button {...triggerProps} aria-label="Toggle" />}>
  <Frame
    leading={<><CollapsibleChevron open={open} /><Badge>{tool}</Badge></>}
    content={label}                                   /* chips+text node, leaf inside */
    meta={<Overlay.Interactive><FilePath filePath={path} /></Overlay.Interactive>}
    trailing={<Overlay.Interactive><RowActions /></Overlay.Interactive>}
  />
</Overlay>
```

No `flex`, no `min-w-0`, no `shrink-0`, no `absolute inset-0`, no `pointer-events-*`
at the call site. Every role is named; the container owns the policy.

## Critical files

- Precedent to mirror byte-for-byte: `plugins/primitives/plugins/spacing/web/internal/stack.tsx`
  (`Stack`, `SpaceStep`, `StackAlign`, `StackJustify`), `…/inset.tsx`,
  `plugins/primitives/plugins/bar/web/internal/bar.tsx`,
  `plugins/primitives/plugins/truncating-text/web/internal/*.tsx`.
- The bug Frame+Overlay close: `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web/components/collapsible-card.tsx:62-122`
  (`CardHeaderAction` → `Overlay.Interactive`; `HEADER` → `Frame`).
- z-layer scale for `Overlay.layer`: `plugins/primitives/plugins/z-layers/web`.
- Plugin scaffolding rules: `plugins/framework/plugins/web-sdk/CLAUDE.md`.

## Verification (of this spec — downstream tasks verify the code)

This task ships **only the doc**. It is "done" when:

- The prop surfaces above are reviewed and approved as the contract the Phase-1 build
  tasks will implement against.
- Each primitive's API answers the vision's two invariants: *containers own
  space-sharing* (Frame's grid tracks, Grid's `minCellWidth`, Cluster/Center's
  internal flex — no per-child negotiation) and *callers express roles, not raw flex*
  (named slots/props, zero raw layout utilities in the composition example above).

Downstream build tasks own the runtime verification the vision lists: the
geometry/bounding-box matrix test per primitive, `bun run test:dom` render fixtures,
and `./equin check` once `no-adhoc-layout` lands.

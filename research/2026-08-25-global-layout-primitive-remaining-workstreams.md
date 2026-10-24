# Layout primitives: the four remaining workstreams

**Date:** 2026-08-25
**Category:** global (css primitives, passthrough, the lint rule, ~60 consumer files)
**Status:** plan, awaiting approval
**Supersedes:** the un-landed half of [`2026-08-17-global-layout-primitive-corpus-gaps.md`](./2026-08-17-global-layout-primitive-corpus-gaps.md)

## Context

`layout/no-adhoc-layout` bans raw Tailwind layout utilities and redirects them to
the primitives under `plugins/primitives/plugins/css/plugins/*`. Feature code
escapes per-site with a named `eslint-disable`. Read as a corpus, those reasons
name a small number of missing shapes rather than 276 independent judgement calls.

The 08-17 plan designed six stages. **Stages 1 and 2.1/2.2 landed** on 08-18
(`8f1af8a32`): the dead-directive guardrail, the rule-message rewrite, `<Layer>`,
`<Rigid>`, and the allowlist drain. Four workstreams remain, and their disable
sites are still in the tree carrying author-written reasons that name the gap.

**Re-measured 2026-08-25** (the doc's numbers moved — the allowlist drain and the
dead-directive purge both landed since):

| | 08-17 | now |
|---|---|---|
| `no-adhoc-layout` directives | 329 | **276** |
| dead directives | 39 | **0 — structurally impossible** (`reportUnusedDisableDirectives: "error"` is live) |
| allowlist globs | 136 | **5**, all permanent (primitives' own source); the reverted tier is empty |

There is no longer a blind spot: the 5 permanent globs cover only primitive
internals, so every feature-code site is visible to grep.

The four remaining clusters, measured:

| workstream | sites | note |
|---|---|---|
| **Coordinate-space positioning** | **56** | largest and fastest-growing |
| **Per-child `self-*`** | **7** in the doc; **8** drainable (2 more found) | |
| **Pin span-inset** | **6** | 3 files × 2, byte-identical |
| **Polymorphic `as`** | **3** in this corpus | the justification moved — see below |

### Two findings that changed the design

**1. `passthrough` landed after the 08-17 doc.** Commit `38b3ca017` replaced the
five `[key: string]: unknown` index signatures with one shared marker,
`Passthrough<E>`, plus two lint rules. The doc's "delete all five in wave 1" is
obsolete: the hole is now named and enforced in one place, but it is still a hole.

**2. The `as` type hole does not exist where the doc said it did.** Compiled
against this repo's exact toolchain (TS 6.0.3, React 19.2.14, `strict` +
`noUncheckedIndexedAccess`): on the 18 primitives typed
`React.HTMLAttributes<HTMLElement>`, `as="buttton"` is *already* an error
(`ElementType` is a union, not `string`), `classname` is *already* an error (the
props type is closed), and `type="submit"` on `as="button"` is *already* an
error — which is why not one of those call sites passes an element-specific prop.
The only genuine defect there is that `ref` is always `Ref<HTMLElement>`.

All real demand sits on the **five open-passthrough primitives**, where every
prop beyond the named list rides the index signature and is therefore *accepted
and unchecked*: `type="buton"`, `href` on a button host, `disabled` on an `<a>`
all compile silently today across **543 call sites**.

Measured cost of going generic (`tsc --diagnostics`, 1,000 synthetic sites):
**+126 type instantiations per `as=` site, +92 per site without one.** Repo
baseline is 3,414,676 instantiations / 238 s. Converting the five is **+1.6%**;
converting the rest is **+10%** for a `ref` fix nobody has asked for.

Current gate state: `./equin check type-check` passes clean (verified).

---

## Order

Cheapest and most contained first, so each lands and is reviewable on its own.
1 and 2 are independent; 3 is the bulk; 4 is types-only.

---

## 1 — `selfClass(align)` (8 sites)

No container primitive owns a *one-child* cross-axis override, and none can: the
override is knowledge the child has and the container does not.

**Where it lives — overruling the doc.** The doc says "next to `insetClass`".
Put it in `spacing/web/internal/stack.tsx`, directly under `ALIGN_CLASS`. The
invariant that matters is that `selfClass(a)` and `<Stack align={a}>` are the
same decision seen from the child and from the container; those two maps must be
adjacent or they drift.

```ts
const SELF_CLASS: Record<StackAlign, string> = {
  start: "self-start", center: "self-center", end: "self-end",
  stretch: "self-stretch", baseline: "self-baseline",
};

export function selfClass(align: StackAlign): string { return SELF_CLASS[align]; }
```

Both spellings written literally — Tailwind's scanner only sees verbatim class names.

**No `<Self>` component, and the reason is structural, not stylistic.** A wrapper
would *become* the flex item, so the alignment would land on the wrapper and the
real child would stretch inside it. `yield`/`grow` are helper-only because there
is nothing to wrap; this one is helper-only because wrapping **breaks** it. Say
so in the docstring, or someone will add the component.

Flex only. A grid child's override is `justify-self-*`, a different property that
nothing in the corpus wants.

**Sites.** 6 disables deleted outright — `events-test-view.tsx:421`,
`summary-pane.tsx:137`, `op-detail.tsx:263`, `prompt-template-chips.tsx:207`,
`window-dock.tsx:110`, `workflow-graph.tsx:99`. Two more found outside the doc's
list narrow to spacing-only: `block-text-renderer.tsx:65`,
`shadow-section.tsx:320`.

Two corrections to the doc's per-site reading:
- `window-dock.tsx:110` **is** fully drained by `selfClass("stretch")` — `w-px`
  and `bg-border` were never banned. The divider/rule follow-up is still right for
  the two *absolutely positioned* hairlines (`resize-handle.tsx:45`,
  `jog-wheel.tsx:84`), but it is not needed to clear this one.
- `app-tab-bar.tsx:136` is **left alone**. `selfClass` fixes half; the other half
  is `items-stretch`, which is `AdaptiveBar`'s own cross-axis alignment and belongs
  in a prop on `AdaptiveBar`. Shipping an `alignClass()` beside `selfClass` would
  drain the disable *and foreclose the right fix*. Update the reason to point at
  the follow-up.

**Discoverability is load-bearing.** `fillClasses()` got zero external callers
while `insetClass()`, advertised in a CLAUDE.md, got six. So: add
`selfClass(align)` to the class-escape sentence in `no-adhoc-layout.ts`'s
`messages.adhocLayout`, and a bullet in `spacing/CLAUDE.md`. No new
`css/plugins/*` directory, so `css:message-names-primitives` needs nothing else.

**Test** — `spacing`'s first non-lint test,
`spacing/web/internal/stack-align.test.ts`. Beyond asserting each mapping, it
carries a *compile-time* exhaustiveness guard so the test's own list cannot
silently stop covering a `StackAlign` member:

```ts
const ALL_ALIGNS = ["start","center","end","stretch","baseline"] as const
  satisfies readonly StackAlign[];
type _Exhaustive = Exclude<StackAlign, (typeof ALL_ALIGNS)[number]> extends never
  ? true : ["StackAlign gained a member with no selfClass twin", never];
const EXHAUSTIVE: _Exhaustive = true;   // ← the line that makes the guard bite
```

**The `const` is load-bearing, and the first draft of this plan omitted it.** A
bare `type _Exhaustive = …` alias is inert: nothing consumes it, so on drift it
merely evaluates to the tuple type instead of `true` and `tsc` stays silent — the
guard was decorative. The annotated `const` is what turns drift into a compile
error; assert it in a test so the binding is used.

Scope it honestly, too: a new `StackAlign` member with no `self-*` twin **already**
fails at `SELF_CLASS: Record<StackAlign, string>` in `stack.tsx`. What this guard
adds is narrower — it stops the *test's* list from drifting out of coverage.

---

## 2 — `Pin` `spanOffset` (6 sites)

Framed as *removing* `pinClasses`' last class-vs-style special case. Every
anchored edge already resolves through `edgeLength()` into an inline style; only
the spanned axis is still a hardcoded `inset-x-0` / `inset-y-0`. After this,
`pinClasses` emits classes only for `absolute`, the z-layer,
`pointer-events-none`, the mask's centering, and the translate trick.

```ts
const spanLen = opts.mask ? "0" : spaceLength(opts.spanOffset);
const stretch = opts.stretch || opts.mask || opts.spanOffset !== "none";
case "top":
  style.top = len;
  if (stretch) { style.left = spanLen; style.right = spanLen; }
  else classes.push("left-1/2 -translate-x-1/2");
```

- **`spanOffset` implies `stretch`**, exactly as `mask` does — an inset on an axis
  that is not spanned would be a silent no-op, and there is no other reading.
- **`outset` does not negate it.** `outset` means "overhang the edge you are
  anchored to"; the spanned axis has no anchor.
- **`mask` forces it to `0`** and does *not* re-express it as padding, unlike
  `offset` — a gap on the spanned axis is the thing `mask` exists to abolish.

**Make it unspellable on a corner** — but *not* with a discriminated `PinProps`
union, which would break `row-actions.tsx:187` (it renders `<Pin to={pin}>` with
`pin: PinAnchor`, the whole union, and a props union cannot accept a union-typed
discriminant). Use a generic with distributive conditionals:

```ts
export interface PinProps<T extends PinAnchor = PinAnchor> extends React.HTMLAttributes<HTMLElement> {
  to: T;
  stretch?: T extends PinEdgeAnchor ? boolean : never;
  spanOffset?: T extends PinEdgeAnchor ? SpaceStep : never;
  …
}
```

`T` is naked so the conditional distributes: `to={pin}` yields `SpaceStep | never`
= `SpaceStep` (row-actions keeps compiling untouched), while a literal
`to="center" spanOffset="xs"` is a type error. `stretch` can be tightened in the
same commit — every current `stretch` site is an edge-center anchor, and the three
`to="center"` sites pass neither.

**No visual change at the 10 existing `stretch` sites**: `inset-x-0` *is*
`left:0;right:0`, no `stretch` site overrides that axis by className, and the two
that override by `style` still win (caller `style` spreads last).

**Migration** at all 6 sites is a nested Pin — 6px hit strip outside, 2px bar
inside:

```tsx
<Pin ref={beforeRef} to="top" stretch decorative className="h-[6px]">
  {isOverBefore && (
    <Pin to="top" spanOffset="xs" decorative className="bg-primary h-[2px] rounded-full" />
  )}
</Pin>
```

**The one real behaviour change, which the commit message must state:**
`inset-x-1` is Tailwind's fixed `0.25rem`; `spanOffset="xs"` is `var(--space-xs)`
— identical at default density, but it now *scales with the density preset*. That
is correct for a semantic ramp and is why the prop exists; a compact-density
screenshot of a tree drag is the check.

`pinClasses` has **zero callers outside its own plugin** (verified), so the change
is contained. Two existing test assertions must be rewritten; add assertions for
span-inset, the implied stretch, `outset` non-negation, mask flushing, and
corner/`center` emitting no span inset.

*Separable follow-up, recommended but its own commit:* `layer/CLAUDE.md` says
"fix Pin's defaults when it is next touched". This is that touch — move
`pinClasses`' defaults into the function (the `layer` precedent) so they stop
being declared twice. Keep it separate so a bisect can tell a default drift from
a mechanic change.

---

## 3 — `<Placed>`, new plugin `css/plugins/coords` (56 sites)

A box placed by runtime numbers: Gantt bars, piano-roll notes, windowed-row
offsets, drag ghosts, crop rects, DOMRect highlights, editor decorations. Pin's
docs explicitly exclude this; the corpus says that call was wrong.

### Three divergences from the doc's sketch, each forced by real sites

**No `<Plane>` and no `planeClasses`.** All eleven "coordinate host" sites are
*already* an existing primitive: exactly `absolute inset-0` → `<Layer>`; an
in-flow clipped track → `<Clip>` + `growClass()`; a plain `relative` sizer →
nothing, because `relative` was never banned. A `Plane` would be a fourth
spelling of three things that have names, forcing every author to answer "Layer
or Plane?" — a question with no observable consequence. What the doc wanted from
it (one place saying "these children are placed by numbers") is a
`## The host` section in `coords/CLAUDE.md`.

**No `motion` prop; the mechanism is per-axis, as a `shift` field on the extent.**
Forced by `virtual-rows.tsx:204` and `notation.tsx:339`, which are
`absolute left-0 right-0 top-0` + `translateY(N)` — their x axis is inset and only
y is composited, which `motion: "transform"; x; y` cannot express. Forced further
by `loop-roll-region.tsx:90`, which needs an inset base *and* a shift on top.
`center` becomes sugar for `shift: "-50%"` — one mechanic, two names.

**`Placed` writes the CSS `translate` property and never `transform`.** This is
what turns the doc's *documented rule* about per-frame writers into a structural
fact — see below.

```ts
export type Coord = number | string;           // px, or any CSS length/percentage

export type Extent =
  | "fill"
  | { start: Coord; size?: Coord; minSize?: Coord; shift?: Coord; end?: never; center?: never }
  | { end: Coord;   size?: Coord; minSize?: Coord; shift?: Coord; start?: never; center?: never }
  | { start: Coord; end: Coord; shift?: Coord; size?: never; minSize?: never; center?: never }
  | { center: Coord; size?: Coord; minSize?: Coord; start?: never; end?: never; shift?: never };

export function placedStyle(x: Extent, y: Extent): React.CSSProperties;
export function placedClasses(opts?: PlacedOptions): string;
export function pct(fraction: number): string;   // the `${f * 100}%` 14 sites hand-rolled
```

- The `?: never` arms make an over-specified extent a tsc error rather than a
  conflict CSS silently resolves. Every arm declares every key, so the resolver
  reads by value instead of `in`-narrowing (which optional-`never` defeats).
- **Both axes required.** Omitting one leaves the CSS *static position* — the one
  genuinely surprising outcome, and the reason the corpus is full of
  `absolute top-0` boxes whose author meant "the top".
- `layer` defaults to **no z class at all** (unlike Pin's `raised`): the bars,
  overlays and marker layers this replaces all paint by DOM order, and a
  `z-index: 0` would open a stacking context none of them asked for.
- Defaults live in `placedClasses()`, not the component — the `layer` precedent,
  deliberately against `pin`'s declare-twice shape.
- `pct()` is unclamped and unrounded: culling an off-screen tick is the caller's
  decision, and rounding would move pixels that are correct today.

### Per-frame imperative writers: the rule becomes unnecessary

All four writers (`progress-bar.tsx:214,248`, `piano-roll.tsx:123`,
`notation.tsx:356`) are `absolute inset-0` and carry **no coordinate**. They are
`<Layer>` sites, not `<Placed>` sites, and the migration sends them there.

The doc's rule — *"must use `motion="inset"` and must not use a `center` extent,
because centering uses `translate(-50%)` which the writer would clobber"* — is
answered structurally instead: **`Placed` owns `translate`, a per-frame writer
owns `transform`, and CSS applies `translate` first, so they compose.** Nothing to
enforce, nothing to remember, no combination to avoid.

*Gate before this lands (5 min, do not skip):* confirm in the built stylesheet
that Tailwind v4's `-translate-x-1/2` compiles to the `translate` property (it
does in v4, which is why `<Pin to="center">` is already safe beside a
`transform`). If it ever emits `transform` there, `Placed` still works — it writes
`translate` directly — but the docs would need a footnote about Pin.

### The `use-gantt-zoom.ts` refactor — confirmed, and the proof is in the consumers

`gantt-rows.tsx:67` does `parseFloat(toLeftPct(...))` — it formats a number to a
string and immediately parses it back, because a string is all the hook exports.
`gantt-container.tsx:101` re-derives the same math by hand rather than reuse it.
Return fractions (`toLeftFraction` / `toWidthFraction`); formatting moves to
`pct()`, and the `0.3%` floor becomes an exported `MIN_BAR_FRACTION` applied as
`minSize`, so a bar's *true* width stays declared and CSS resolves
`max(width, min-width)`.

Two behaviour notes the diff must carry: `y="fill"` emits `top:0;bottom:0` where
sites wrote `top-0 h-full` (same box, drops an `h-full` that only worked because
the track had a fixed height); and the old `Math.max(x, 0.3)` floored *even a
zero-length span*, so `minSize` needs a `durationMs > 0 ? … : undefined` guard or
an empty Gantt paints a 0.3% sliver per row.

### Migration phases, ordered

| | scope | what could regress |
|---|---|---|
| **B0** | Layer handover — 11 hosts (Sonata overlays, progress, piano-roll). No dependency on `coords`; can land first. | `layerClasses()` defaults to `z-base` where these had `z-index: auto`. Order-preserving among siblings, but each becomes a stacking context. Screenshot Sonata **with playback running**. |
| **B1** | Profiling Gantt + the fraction refactor, one commit (the context type change reaches timeline and op-gantt). | `minSize` floor semantics; `y="fill"` vs `top-0 h-full`. Check Debug → Profiling zoomed and unzoomed. |
| **B2** | Timeline + op-gantt (9 sites). | `gantt-rows.tsx:72` is `start`, **not** `center` — the original had no `-translate-x-1/2`, so the tick box's left edge is on the fraction and only its *contents* are centered. Getting this wrong shifts every tick by half a label. |
| **B3** | Windowed lists (introduces `shift`). | Mechanism moves from `transform: translateY` to `translate: 0 Npx`. Both composite; a regression here shows as scroll jank, not a wrong pixel. Scroll a 10k-row list and a long score. Also **delete, don't convert**, the dead directives in this cluster (`virtual-rows.tsx:182`, `notation.tsx:312,321,323`, `songsheet-line.tsx:64` — their only class is `relative`). |
| **B4** | Measured-rect overlays (crop, picker, canvas-edge, draw-canvas). | `crop-overlay.tsx:70` carries `setPointerCapture` — `Placed` must **be** that element, never a wrapper. `canvas-edge.tsx:55` must move `pointer-events-auto` onto the `Placed`. |
| **B5** | Editor decorations. | `format-toolbar-plugin.tsx` keeps its own `transform` — they compose, but confirm the "above" placement still lifts by its own height. `selection-bands.tsx:39`'s outer element stays a disable (`gridRow` span is a grid mechanic). |
| **B6** | Sonata projection family, last (tightest domain coupling). | `railBandClass` (`scrubber/web/rail-geometry.ts:23`) is a shared class const consumed by two families — make it an exported `Extent` constant, or they drift. Screenshot with playback running. |

### Explicitly not covered, by file

- **`position: fixed`** — stays with `viewport-overlay` / `cursor-menu`; a `fixed`
  mode would re-open the transformed-ancestor bug those exist to prevent. Note
  `format-toolbar-plugin.tsx:431,451` *are* in scope — they are `absolute` inside
  a `ViewportOverlay`.
- **Hit-test elements where inserting a child is a behaviour change, not a
  refactor:** `keyboard.tsx:352` (pointer handlers read `data-pitch` off the
  topmost element under the pointer; a wrapper becomes that element and breaks
  glissando), `block-rail.tsx:57` (the absolute box *is* the `<button>` carrying
  dnd-kit listeners).
- **`window-chrome.tsx:315`** — window chrome, not a coordinate box.
- `collapsible-wrap.tsx:148` (wants a negative z rung that doesn't exist) and
  `data-table.tsx:166` (subgrid — its own follow-up).

### Scaffolding, tests, wiring

Mirror `css/plugins/layer` exactly: `package.json`, `web/index.ts` (named
re-exports + default `PluginDefinition`), `web/internal/coords.tsx`,
`web/internal/coords-classes.test.ts`, `CLAUDE.md` with an AUTOGENERATED block,
plus `fixtures/`.

- **No lint-allowlist edit** — the permanent `css/plugins/**` glob already covers
  a new sub-plugin's source.
- **`css:message-names-primitives` does require an edit**: every `css/plugins/*`
  directory must be named in `no-adhoc-layout.ts`'s message or classified as
  non-layout. Add a `coordinates` line naming `css/plugins/coords` and `pct()`,
  and add `placedStyle(x, y)` to the class-escape sentence.
- **Pure test**: the doc wanted `planeClasses` to assert *equality with*
  `clipClasses`/`fillClasses`. `planeClasses` is gone, so the same discipline
  applies to `zLayerClass` — assert `placedClasses({layer:"overlay"})` equals
  `` `absolute ${zLayerClass("overlay")}` ``, never a literal `z-overlay`. Plus:
  `transform` is never emitted on any input; no `shift` ⇒ no `translate` key at
  all; and `@ts-expect-error` cases for the over-specified arms.
- **Harness fixture**: `fixtures/index.ts` is auto-discovered (collected-dir, no
  wiring). Three `%`-placed bars in a clipped track, `noClip` + `noOverlap` across
  the width sweep. This needs **one new mutation kind**, `unpositionHost`, in
  `layout-harness/core/types.ts` + `entry.tsx` — none of the existing seven
  reproduces a coordinate fault, and the real one is losing the positioned
  ancestor so offsets silently re-resolve further up.

---

## 4 — Polymorphic `as`, the five open-passthrough primitives only

**Scope: `Badge`, `Line`, `Card`, `Surface`, `ToggleChip` (543 call sites).**
Waves 2 and 3 from the doc are **cut** — record why here so it is not
re-litigated: the closed 18 already reject typos and bogus tags, their only hole
is `ref` variance, and converting them costs ~+10% on a 238 s type-check for no
demonstrated demand. If the `ref` hole ever bites, narrow
`ref?: React.Ref<HTMLElement>` per primitive in isolation.

### The `Passthrough` question — the premise turned out to be false

The concern was that `React.ComponentPropsWithRef<T>` has no string index
signature, so converting would drop these primitives out of
`no-unanchored-passthrough`, whose subject gate is
`propsType.getStringIndexType() === undefined` (`no-unanchored-passthrough.ts:442`).

Probed directly with `ts.createProgram` + `getIndexInfoOfType`:

| shape | string index |
|---|---|
| generic marker, `T` unresolved | **present** |
| open marker (today) | present |
| generic marker pinned to `"div"` | absent |
| plain `HTMLAttributes` | absent |

Inside a generic body, `Omit<ComponentPropsWithRef<T>, …>` is a deferred type
whose *apparent* type carries a string index. **The rule keeps firing with zero
edits** — and converting *pulls primitives in* rather than dropping them.

The genuine loss case is the one nobody is proposing: pinning to a concrete host
(`<"div">`). That is `OverlayPanel`, `ViewportOverlay`, `SurfaceOverlay`,
`SectionHeaderRow`, `TabProps`, `Row` — all of which have no `as` and **stay on
the open marker**.

**Decision.** Keep `Passthrough<E>` exactly as it is, and add a sibling marker in
the same plugin — the closed spelling of the same promise:

```ts
export type HostPassthrough<T extends React.ElementType, Own = unknown> = Own & {
  as?: T;
} & Omit<React.ComponentPropsWithRef<T>, "as" | keyof Own>;
```

- `Own` is *omitted from* the host half, not intersected with it — an intersection
  of two types for one key produces `never` (`<Stack wrap>` boolean vs
  `<textarea wrap>` string would become unusable rather than an error). It is a
  parameter rather than a `&` at the call site so nobody can forget it.
- `"as"` is omitted unconditionally — `ComponentPropsWithRef<"link">` has an `as`
  attribute of its own.
- `ref` is **not** declared; it arrives inside `ComponentPropsWithRef<T>`,
  correctly typed per host. Converting primitives delete their explicit `ref` line.

**Ladder argument.** Today "what may you pass" sits at rung 5 (nothing) while
"where does it land" sits at rung 3 (lint). The generic moves the first to
**rung 2** — a typo on a real prop, a `href` on a button host, a wrong-element
`ref` all become compile errors — and the measurement says it does not cost the
rung-3 guarantee. The residual risk is that rung 3 now leans on a compiler
implementation detail, so the proportionate answer is a rung-3 test: **do not
widen the rule's type gate** (a speculative second detection path for a case that
already works), but add one `invalid` fixture to
`no-unanchored-passthrough.test.ts` — a generic `HostPassthrough` component
spreading its bag off the `ref` element — with a comment saying it exists because
subject detection rides TS's apparent-type computation. If a TS upgrade changes
that, a red test says so instead of the guarantee lapsing silently.

Extend **`no-anonymous-passthrough`** with the generic form of the same offence:
inside a `*Props` declaration generic over `T extends React.ElementType`, a
reference to `ComponentProps*<T>` not routed through `HostPassthrough` is the
anonymous generic passthrough. Scoped that tightly it has **zero** false
positives — all 23 existing `ComponentProps<…>` uses are at a fixed host.

### What actually compiled

All 11 positives clean, **no cast anywhere in a component body** — including
`rest.role === undefined`, `onKeyDown?.(e)`, and `Text`'s two-return-path body.
6 of 7 `@ts-expect-error` negatives fired.

Three surprises to write into the docstring:
1. **`children` on a void host is not rejected** — `<Center as="img" …>kids</Center>`
   compiles. TS's JSX children check does not tighten through the generic. Don't
   promise it.
2. **When the host is another *generic* primitive, checking collapses entirely** —
   `<Stack as={Fill} axisss="y">` compiles silently. ~46 such sites exist. They
   gain nothing, but lose nothing: they are equally unchecked today.
3. The typo negative (`classname`) is the one that matters — it is the exact class
   of bug the index signature has been swallowing.

### Composition boundaries

Generic → generic always needs one cast: with `T` unresolved, no object is
assignable to the callee's opaque host half. Standardise on the shape that keeps
the callee's **named** props checked:

```ts
export type HostAgnostic<Own> = (
  props: Own & { as?: React.ElementType } & Record<string, unknown>,
) => React.ReactNode;
```

A missing required `gap` or a `gap="huge"` still errors; only the host half goes
opaque, which is the half the caller cannot know. Its stated cost: a typo in one
of the callee's *named* props falls into the bag. (Rejected: casting the whole
assembled props object swallows typos in *every* named prop; instantiating the
callee at a concrete host needs a second, lying cast.)

| boundary | handling |
|---|---|
| ToggleChip → Badge | `const B = Badge as HostAgnostic<BadgeOwn>`. Conditional `type`/`disabled` stays unchecked — unavoidable, `T` isn't known to be `"button"` there. Same as today. |
| Card → Surface | `const S = Surface as HostAgnostic<SurfaceOwn>`. Both delete hand-written `onKeyDown`/`tabIndex` — those become host-typed. |
| Bar → Line | **No cast.** `Bar` stays closed: 0 `as=` sites, host is `tier`-derived at runtime, so a literal default would be a lie. |
| Row → Line | One cast covering both return paths. `Row` **keeps** `extends Passthrough` — the open marker is what keeps it enrolled in the rule this plugin was built around. |
| 3 tab variants → Line | Not in the doc's list. `TabProps extends Passthrough` gives `Ref<HTMLElement>`, which **fails** on ref invariance into `<Line as="div">`. Fix: narrow to `Passthrough<HTMLDivElement>` in `ui/tab-bar/core/types.ts` — all three render a div. The conversion catching real looseness, for one word. |
| Cluster/Inline → Stack, SectionLabel → Text | Out of scope — `Stack`/`Text` are not converted. |

### Order and fallout

`Badge` → `Line` → `Card`+`Surface` (one commit; they are one composition) →
`ToggleChip`. Badge first: most call sites but the simplest shape (no `ref`
destructure, one `{...rest}`), so it calibrates the fallout estimate before
`Line`, which drags `Bar`, `Row` and the three tabs with it.

~30 of the 543 sites spread a props object in. **Every error surfaced is a genuine
bug** — these props have never been checked. Never suppress one; if `disabled`
turns out to be on an `<a>`, the site is wrong, not the type.

### `Row`'s discriminated union — confirmed out

`Row` has no `as`; it *infers* its tag. It is not a polymorphic-host primitive but
a variant primitive that renders different tags, and its real problem (`href` and
`onClick` independently optional when they should be three exclusive arms) needs a
union over its own props, touching `CONTROL_KEYS` / `RowControlProps` /
`splitPassthrough` routing. Separate work.

---

## Verification

- **Per primitive:** pure `*-classes.test.ts` co-located with the source,
  `./equin test plugins/primitives/plugins/css/plugins/<name>`.
- **Geometry:** the `coords` fixture plus the new `unpositionHost` falsification.
  The harness check keys its cache on the whole `css/plugins/**` tree plus every
  fixture contributor's subtree, so it re-runs automatically and launches no
  browser when untouched.
- **Types:** `./equin check type-check` after each `as` conversion, plus
  `--diagnostics` before and after — the prediction is +126/site with `as=`,
  +92/site without, and a wild miss means the shape is wrong, not the budget
  optimistic. One `@ts-expect-error` fixture per converted primitive, co-located
  as `<name>-types.test.tsx` (**overruling the doc's `web/__tests__/`** — the repo
  already has this pattern twice, at `optimistic-mutation/web/internal/args-types.test.ts`
  and `pane/web/pane-write-path-types.test.ts`; `web/__tests__/` is jsdom/vitest,
  the wrong runner and a different program).
- **Lint, positively at least once:** after converting `Line`, temporarily move
  `{...rest}` off the `ref` element and confirm `restOffRef` still reports. If it
  does not, the apparent-type behaviour has changed and the workstream stops.
- **Visual, per coords phase:** `./equin build` (background), then the e2e
  screenshot script — Debug → Profiling for the Gantt, Debug → Slow Events for the
  timeline, a data-view list for windowed rows. **Sonata must be checked with
  playback running**; a static screenshot cannot show that the per-frame writers
  still move.
- **Whole gate:** `./equin check` — `eslint` (the migrated disables must be
  *gone*, and a leftover directive is itself an error), `type-check`,
  `layout-geometry`, `css:message-names-primitives`.
- No visual check is needed for workstreams 1 and 4: `selfClass` emits
  byte-identical class strings, and the `as` conversion is types-only.

## Follow-ups (not in this plan)

- **`alignClass()` / an `AdaptiveBar` alignment prop** for `app-tab-bar.tsx:136`.
- **A `divider`/`rule` primitive** for the two absolutely-positioned hairlines
  (`resize-handle.tsx:45`, `jog-wheel.tsx:84`).
- **The subgrid data-table** (10 sites, still growing) and its newly-surfaced
  sibling shape — 5 grid-row-span line-spanning overlays in the page editor.
- **`Row`'s 3-arm discriminated union.**
- **`ref` variance on the closed 18**, if it ever bites.

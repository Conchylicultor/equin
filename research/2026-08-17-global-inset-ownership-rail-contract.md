# Inset ownership: the rail contract, and a gate that cannot be told what to measure

## Context

The repo enforces *which* spacing vocabulary you may use — ~15 `no-adhoc-*` rules
cover spacing, radius, typography, control size, surface, layout, z-index — but
nothing enforces **who** applies a given inset between a container and its
children. A container and a child can both apply it (doubled), or neither can
(flush against the edge), and every existing rule green-lights both: they read
raw class values, and both failure modes are spelled with perfectly legal tokens.

The same problem has been solved at least five times, each with a bespoke
mechanism:

| Instance | Mechanism |
| --- | --- |
| `data-view` | `--pane-gutter` + a `pane-gutter-flush` utility, documented "so the gutter isn't double-applied" |
| `ui-kit` `DialogContent` | a `padded` prop, `false` "for flush header/list panels whose rows self-inset" |
| `ui-kit` `POPOVER_PADDING` | co-publishes `--scroll-pad`, because a padding role is only a class name and its length is otherwise unreadable to CSS |
| `ui-kit` surfaces | `--chrome-mask` / `--hover-fill`, publish-your-own-role vars so a child can adapt to the surface it landed in |
| `css/text` | "three orthogonal axes (they compose, no double-apply)" |

The fifth shipped as a visible bug in the new `control-panel` primitive:
`ControlPanelPopover` set popover padding to `none` and let the body own the
inset, while the previous host (`InlinePopover`) defaulted to `padding="md"`, so
migrated panels silently lost most of their edge inset. Compounding it,
`ControlPanel` only inset its `Row` children, so a raw `Input` or a contributed
`FieldRenderer` dropped into a `Section` sat flush at ~4px while the section
label above it was indented ~30px — three left edges in one panel.

That instance is fixed on `main` (`ee23c1ea3`), and the fix is *correct*: `cp-panel`
is named "THE INSET OWNER", it publishes `--cp-inset-start`, and `cp-row` cancels
and re-applies it. But three things stayed local to that one plugin:

- The rule exists only as prose in `control-panel/CLAUDE.md` ("Every other
  participant either inherits it or cancels it, never both").
- The escape is hardcoded: `cp-row`'s bleed reads `--cp-inset-start`, so it is
  only correct *inside a control panel*.
- The regression gate is a sentence — "**Any new fixture must render something
  other than a `Row`**" — which is rung 5 of the fix ladder, in one plugin's docs.

That last one is the real gap. `./equin check layout-geometry` is a genuine
automated gate: real headless Chromium, a pure oracle, sig-cached, wired into
`check`. It went green through three of these bugs because **every fixture
authors its own children**, so a container is only ever measured against the
child kind it already handles.

**Outcome of this plan:** one stated contract with one mechanism, and a gate whose
child set the fixture author cannot choose.

## The mental model

Padding is treated as decoration you add to a box. Decoration is invisible from
outside, so nobody can tell whether it has already been applied. The reframe:

> **Applying inline padding is the act of opening a region.** A box either *opens*
> a region — declares where its contents' left edge is — or *lives* in one, and
> does nothing. There is no third thing. "Both applied it" is what *opened a
> region without meaning to* looks like from the outside.

Five principles follow, plus one about enforcement:

1. **The edge owner owns the inset.** The rail belongs to the box that owns the
   region's *edge* — a surface border, a scroll box, a pane boundary. A child
   never owns that edge, so it never owns the rail. It owns only its own internal
   pad (`p-card`, `p-chip`, `p-control`), which sits inside its own border box and
   composes additively with no bug. The token layer already draws this line; the
   code does not.
2. **You inherit alignment by doing nothing.** If content must opt in to be
   aligned, the rail is on the wrong box. This is the falsifiable test, and it is
   exactly what shipped broken: the rail lived in `cp-row`'s grid *tracks*, so a
   raw `Input` opted out by existing.
3. **The only escape is cancel-and-reapply, as one act.** Cancel alone is the
   flush bug; add alone is the doubling bug. Both halves must be indivisible.
4. **Publish what a descendant must adapt to.** `theme/CLAUDE.md` already names
   this "the publish-your-own-role contract" for `--chrome-mask`, `--hover-fill`
   and `--scroll-pad`. Inset is the member nobody generalized.
5. **Nesting is shadowing, not accumulation.** A nested region re-declares the
   rail on its own box; its children read the new value. Regions nest, insets do
   not pile up on one box.
6. **(Enforcement) A rail is proven by the child that knows nothing about it.**
   Measuring a container against the child it was designed for proves nothing.

## The contract

One inherited variable pair, repo-wide — `--rail-start` / `--rail-end` — and two
utility classes. A single shared pair (rather than per-region names) is what makes
nesting free: an inner region shadows the outer value by plain CSS inheritance, so
nothing needs wiring. It is also what makes the escape *portable*: a `rail-bleed`
child reads whatever region it actually landed in, so a row primitive bleeds
correctly wherever it is dropped, which `cp-row` cannot do today.

```css
/* THE OWNER — publishes the rail in the same breath as applying it, so the
   number exists once and a descendant can read it. */
@utility rail-lg {
  --rail-start: var(--space-lg);
  --rail-end:   var(--space-lg);
  padding-inline: var(--rail-start) var(--rail-end);
}

/* THE ONLY ESCAPE — cancel and re-apply are ONE class, so you cannot write half
   of it. The width term pays back what the negative margins gave away: a
   <button> host sizes to its content, so `width: auto` would shrink it. */
@utility rail-bleed {
  margin-inline: calc(-1 * var(--rail-start)) calc(-1 * var(--rail-end));
  width: calc(100% + var(--rail-start) + var(--rail-end));
  padding-inline: var(--rail-start) var(--rail-end);
}
```

The three cases stop being negotiations:

```tsx
<div className="rail-lg">           {/* one owner; publishes --rail-start: 1rem */}
  <Row className="rail-bleed" />    {/* fill reaches the edge, label back on 1rem */}
  <Input />                         {/* does nothing → lands on 1rem */}
  <div className="rail-sm">…</div>  {/* opens a NESTED region; its children on ITS rail */}
</div>
```

Custom-property inheritance passes through `display: contents` wrappers — which
matters, since that is exactly what defeated `control-panel`'s original sibling
selector for its hairlines, and `renderIsolated` wraps every contributed panel in
one.

## Changes

### 1. New plugin — `plugins/primitives/plugins/css/plugins/rail/`

A leaf primitive owning the contract itself.

- `core/index.ts` — `RAIL_START_VAR = "--rail-start"`, `RAIL_END_VAR = "--rail-end"`,
  and the `RailStep` type (reuse `SpaceStep`'s ramp shape; the values live in the
  density token group as today).
- `web/internal/use-rail-guard.ts` — `useRailGuard(label)`, the dev-only runtime
  guard. **Mirror `plugins/primitives/plugins/data-view/web/internal/use-dev-guards.ts`
  byte-for-byte in shape**: `import.meta.env.DEV` early return, one
  `requestAnimationFrame` for layout to settle, `console.error` (loud but never
  throws — safe on overlay/SSR edges), returns the ref to attach, and lives in its
  own hook so the ref read stays out of the host component's React Compiler
  analysis.

  It reads the root's computed `--rail-start`, then for each direct child element:
  skips children generating no boxes (`getClientRects().length === 0` — the same
  non-participant rule `__measure` already applies), skips children whose own
  computed `--rail-start` differs from the root's (they opened a nested region),
  and otherwise compares `rect.left + parseFloat(paddingLeft)` against
  `root.left + railStart`, reporting the offenders and the delta.
- `CLAUDE.md` — the mental model above, stated once, as the canonical home.

### 2. The utilities — `…/css/plugins/ui-kit/web/theme/app.css`

Beside the existing spacing ramp (~line 685). Ship the full 8-step ramp for the
same reason `px-*` ships all eight — an asymmetric ramp is worse than a slightly
larger one:

```
@utility rail-none|2xs|xs|sm|md|lg|xl|2xl   /* twmerge: sg-rail */
@utility rail-bleed                          /* twmerge: standalone -- <reason> */
```

Declare the synthetic group once in the section-header comment:
`/* @twmerge group sg-rail conflicts: px p */` (multi-property, so it cannot use
`extend`). `./equin build` regenerates `custom-utilities.generated.ts`;
`app-css-utilities-in-sync` guards it. Named-suffix utilities auto-pass
`no-adhoc-spacing` — **no lint edits anywhere in this plan**.

### 3. The gate — `plugins/primitives/plugins/css/plugins/layout-harness/`

The structural fix: a fixture kind that hands the harness a *hole* instead of a
child list. It is pure sugar — it expands into the existing `LayoutFixture`, so
all three consumers (bun:test, check, Layout Lab gallery) need no changes and the
gallery renders it for free.

**`core/types.ts`** — add beside `LayoutFixture`:

```ts
export interface RegionFixture {
  kind: "region";
  id: string;
  primitive: string;
  widths: number[];
  /** The region under test, wrapping children the HARNESS supplies. */
  render: (children: ReactNode) => ReactElement;
}
export type HarnessFixture = LayoutFixture | RegionFixture;
```

plus `isRegionFixture` (mirroring `isLayoutFixture`), a `railAlignment` invariant
kind, and a `railOverride` mutation:

```ts
| { kind: "railAlignment"; epsilon?: number }
…
| { kind: "railOverride"; value: string }   // force a wrong/absent rail
```

`MeasuredFixture` grows two things the oracle needs and cannot compute:
`slots[k].contentLeft` (`rect.left + parseFloat(paddingLeft)` — the idiom the
callout/context e2e scripts already use) and `railStart` / `railEnd`, read off the
container's computed style. Because the pair is shared repo-wide, `__measure`
always reads the same two names — no per-fixture parameterization.

**`core/oracle.ts`** — `checkRailAlignment(measuredByWidth, epsilon)`: at every
width, every measured slot's `contentLeft` ≈ `container.left + railStart`. Add the
`evaluateInvariant` case and its `core/oracle.test.ts` coverage on synthetic
boxes. A region whose container publishes no rail fails with a named message —
which is what makes publishing load-bearing rather than polite.

**`web/internal/region-children.tsx`** — the one kit, `web/` because it imports
ui-kit components and `core/` may not cross runtimes (`no-cross-runtime-import`):

```tsx
export const REGION_CHILDREN = [
  { id: "bare-input",  node: <Input data-geo="bare-input" /> },
  { id: "bare-button", node: <Button data-geo="bare-button">Go</Button> },
  { id: "bare-text",   node: <Text data-geo="bare-text">Label</Text> },
  { id: "contributed", node: <div style={{ display: "contents" }}><Text data-geo="contributed">Slot</Text></div> },
  { id: "bled",        node: <div className="rail-bleed"><Text data-geo="bled">Row</Text></div> },
];
```

**`web/internal/expand-region-fixtures.ts`** — maps each `RegionFixture` to a
`LayoutFixture` rendering the *whole* kit in one region (one render, N slots), with
invariants `[{ kind: "railAlignment" }, { kind: "noClip" }, { kind: "falsification",
mutate: { kind: "railOverride", value: "0px" }, expectViolated: { kind: "railAlignment" } }]`.
Called by both web consumers (`layout-geometry.test.ts`, `gallery.tsx`);
`loadFixtures()` in `core/` just widens to `HarnessFixture[]`.

**`web/internal/entry.tsx`** — `applyMutation` handles `railOverride` by setting
the two custom properties on the container; `__measure` populates the new fields.

**`check/classify.ts`** — add `railAlignment` to `ORACLE_INVARIANT_KINDS` (its own
comment already says a new oracle kind must be listed here, or a real regression
would be misclassified as an environmental timeout and pass non-fatally).

**`CLAUDE.md`** — document the region-fixture kind and *why* the kit is not
authorable.

### 4. Two seed regions, so the gate has teeth

Nothing is migrated or deleted. Two existing owners opt into the contract by
publishing the shared pair alongside what they already publish, and each
contributes a `RegionFixture`:

- `cp-panel` in `app.css` — add `--rail-start: var(--cp-inset-start); --rail-end:
  var(--cp-inset-end);`. Its `fixtures/` dir already exists; add the region fixture
  at both width roles (262 / 524).
- `px-pane-gutter` in `app.css` — add `--rail-start` / `--rail-end` from the same
  `var(--pane-gutter, var(--chrome-pad-x))` expression it already resolves. Add a
  `fixtures/index.ts` to `data-view` (new contributor; the collected-dir
  auto-discovers it on build).

Attach `useRailGuard` in `ControlPanel` and in the `DataView` root beside the
existing `useDataViewDevGuards`.

### 5. Docs

- `.claude/skills/css/SKILL.md` — a "Who owns the inset" section carrying the
  model and the two utilities, next to the overlap bug class.
- `…/ui-kit/web/theme/CLAUDE.md` — add `--rail-start`/`--rail-end` as a row in the
  publish-your-own-role table, where `--scroll-pad` already sits.
- `control-panel/CLAUDE.md` — replace "Any new fixture must render something other
  than a `Row`" with a pointer to the region fixture, since the prose is now
  mechanized.

## Explicitly out of scope

- **No migration of the five.** `--pane-gutter`, `DialogContent.padded`,
  `--scroll-pad`, `--cp-inset-start` and `detail-sections`' `pane-gutter-flush` all
  keep working unchanged; two of them merely also publish the shared pair.
- **No lint rule, no static check.** `--rail-*` is inherited, so a box that pads
  with a plain `px-lg` still creates silent drift between its real inset and the
  published rail. The gate catches that only for regions registered as fixtures.
  Closing it everywhere needs the static check "a box owning an inline inset must
  publish it" — deliberately deferred, and the reason the contract is designed so
  that check has something to read.
- **Inline axis only.** That is where this bug class lives. `rail-bleed` assumes a
  block-level host — the reason `cp-row` needs its `width` term.

## Verification

1. `./equin build` — regenerates `custom-utilities.generated.ts` and
   `fixtures.generated.ts` (the new `data-view/fixtures` contributor). Then
   `./equin check` (`app-css-utilities-in-sync`, `type-check`,
   `plugin-boundaries`, `collected-dir-tsconfig-coverage`, `plugins-doc-in-sync`).
2. `bun test plugins/primitives/plugins/css/plugins/layout-harness/core/oracle.test.ts`
   — the pure `checkRailAlignment` proof on synthetic boxes.
3. `./equin check layout-geometry` — green, **and its falsification must
   bite**: the `railOverride` case has to report `railAlignment` VIOLATED, or the
   suite throws `falsification did not bite`. Run twice; the second run must
   short-circuit on the sidecar marker with no Chromium launch.
4. **The negative that matters — prove the gate now catches the shipped bug.**
   Temporarily revert `cp-panel` to inset via the row tracks only (drop
   `--rail-start` from it) and confirm `control-panel/region` goes red naming
   `bare-input` and `bare-button`. This is the case that passed green three times.
5. Debug → **Layout Lab**: the two region fixtures render their mixed kit at each
   width; the bare `Input`, the `Button`, the `display:contents`-wrapped text and
   the bled row all share one left edge.
6. Dev guard: open `/tasks`, then a Filter panel, with devtools open — no
   `[rail]` console errors. Then temporarily drop a `<div className="px-xl">`
   around a panel child and confirm it reports the offender and the delta.

## Critical files

- `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css` — the two
  utilities (+ the twmerge group header), and the two seed publications at
  `cp-panel` (~L493) and `px-pane-gutter` (~L435).
- `plugins/primitives/plugins/css/plugins/layout-harness/core/{types,oracle}.ts` —
  the `RegionFixture` kind, `railAlignment`, `railOverride`.
- `…/layout-harness/web/internal/{entry.tsx,region-children.tsx,expand-region-fixtures.ts}`
  — the measurement additions and the non-authorable kit.
- `…/layout-harness/check/classify.ts` — `ORACLE_INVARIANT_KINDS`.
- `plugins/primitives/plugins/data-view/web/internal/use-dev-guards.ts` — the
  exact shape `useRailGuard` copies.
- `plugins/primitives/plugins/css/plugins/control-panel/CLAUDE.md` — the prose the
  contract generalizes, and the sentence it replaces.

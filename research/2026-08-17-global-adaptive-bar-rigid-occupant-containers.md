# The width ledger's axiom, enforced: an occupant container that cannot be squeezed

## Context

`plugins/primitives/plugins/adaptive-bar/core/width-cache.ts` opens by stating
the rule the whole primitive rests on:

> we only ever measure the rung an item is *currently rendering inline* … the
> ledger's job is to keep what it legitimately learned

An entry is keyed `(item id, rung)` and marked `exact`, which asserts something
stronger than the header spells out: **an occupant's width at a rung is a
property of that occupant and that rung** — not of how many neighbours it
happens to be sitting beside. Nothing enforces that today.

Each occupant lives in a bare `document.createElement("div")` minted by
`PortaledBarItem`. That div is an ordinary flex item of the bar's row
(`flex: 0 1 auto`), and several widgets hold a truncating leaf (`Badge`'s label
is `truncate`; `<Text>` under the bar's `SingleLineProvider` is
`min-w-0 truncate`), so their min-content width is small. When the row is
momentarily over-full the layout engine squeezes those containers — and
over-full is *exactly the state the bar measures in*: `reconcile` measures the
placement React has already committed, before the next one has been decided.

Three consequences, all invisible:

1. **The ledger stores a placement-dependent number as `exact`.** Every later
   fit decides from a width the item does not have, and the mistake is sticky:
   the item is only re-measured at the rung it currently sits at.
2. **The row-overflow guard goes blind.** Flex absorbs the whole deficit, so the
   occupants' boxes sum to exactly the available width and
   `measureRowOverflow` measures no overflow. The one guard that would have
   noticed the fit was wrong is the one the squeeze silences.
3. **The shrink ladder stops engaging.** When flex absorbs the deficit the
   rendered widths sum to exactly the content box; the next pass reads them
   back, `doesFit()` compares that same sum against the same width, and `assign`
   concludes the row fits — so it never demotes anyone.

## What is actually true today, measured rather than argued

The filed defect says several widgets "hold a truncating leaf … which makes
their min-content small". **That reasoning is wrong**, and it took three
measurements to establish:

- The app tab strip, driven to 12 tabs at 760px on `main` and on this branch:
  **byte-identical**. 0 squeezed either way, the same 3 tabs at the compact
  rung. The ladder already engages; nothing visible changes.
- A layout-harness fixture of four chips holding a truncating `<Text>`, swept
  880→340px with the fix removed: **no squeeze**. Same with the label wrapped in
  a `Fill` (`min-w-0 flex-1`).
- The same fixture with occupants whose content can **reflow** (wrapping text),
  fix removed: **all four collapse 186px → 83px**.

The mechanism: an occupant container is a flex item with `min-width: auto`, so
its floor is its own min-content — and under the row's `whitespace-nowrap` a
text run cannot break, so its min-content *is* its natural width. `min-w-0`
inside a widget lowers the leaf's floor, not the container's. So every occupant
shipping today is unsqueezable **by accident**, and the axiom is upheld by a
coincidence of content rather than by anything anyone wrote.

That accident breaks for a widget whose content can reflow narrower (a wrapping
sentence, a percentage-sized image), and it breaks for the whole bar if the
row's `whitespace-nowrap` is ever overridden or the container ever gains
`min-width: 0` / `overflow: hidden`. None of that is announced, and the failure
is silent — a stored width that is a lie, in the one ledger the fit trusts.

So this is a **latent hole closed, not a visible bug fixed** — which is the
honest framing, and the original filing's instinct was right.

## The decision

**The measuring row never takes width from what it holds.** `BAR_ROOT` gains
`[&>*]:shrink-0`, so every child of the bar's own row is a rigid flex item and a
measured width is the item's own width at its rung by construction. A
placement-dependent width stops having a spelling.

**On the row, not on the item**, and that is not a stylistic choice:

- The `⋯` **trigger** is a flex item of the same row and is measured by
  `measureTrigger`, which *caches the first non-zero reading it gets* and, for a
  hidden trigger, never re-reads it. Making only the occupant containers rigid
  would leave the trigger as the sole shrinkable item in an over-full row —
  absorbing the entire deficit and permanently caching a squeezed width, which
  under-reserves the `⋯` in every later fit and manufactures exactly the
  `row-overflow` fault this change exists to make visible again.
- The occupant container lives in **two flex contexts with orthogonal main
  axes** — the row, and the panel dock's column. A declaration on the container
  means "rigid horizontally" in one and "rigid vertically" in the other. Stated
  by the row, it means one thing.
- It covers anything the row holds later without anyone having to remember.

That is the primitive's own thesis rather than a new rule: *overflow as
relocation, not transformation*. A CSS squeeze is a transformation the widget
never declared, the host never asked for, and the ledger cannot see. The shrink
ladder — the smaller forms a widget declares through
`action-presentation`'s `useActionForm` — becomes the only way an occupant gets
narrower, which is what the whole primitive is for.

**Every consumer was surveyed before choosing this**, because it changes the
rendered result for all of them. None relies on the squeeze:

| consumer | occupant | relies on flex-shrink? |
|---|---|---|
| `apps-core/tab-bar` | `TabChip` — `max-w-40` + truncating `Text`, one declared rung (full ⇄ icon-only) | no: the cap is the chip's own `max-w-40`, the shrink is the bar's JS ladder |
| `apps/sonata/library` | `PickerOption` — a rigid button, declares no smaller form | no |
| `conversations/…/prompt-templates` | `TemplateChip` — a `ButtonGroup`, `overflow="clip"` | no |
| `primitives/pane` (header actions) | `IconButton`s declaring the `"row"` rung | no |
| `reorder/node-types/overflow` | `AdaptiveBar.Collapsed` — never laid out inline | n/a |
| own fixtures | icon buttons, a two-rung volume control, a fixed-width jog wheel | no |

The visible change is therefore confined to what happens when a row is genuinely
over-full, and in each mode it is the behaviour the mode already documents:
`scroll` scrolls instead of squashing every tab to a sliver, `panel`/`clip` clip
the excess (which only happens at the fit's floor), and in the ordinary case the
fit now decides from true widths and demotes to the compact rung when it should.

### Why not the alternatives

- **Measure with shrink temporarily disabled** (set `flex-shrink: 0` on every
  inline container, read, restore) keeps today's squeeze but costs a forced
  reflow on every over-full pass — and it preserves a rendered state the
  primitive's thesis rejects. It buys graceful ellipsis for a transient state
  that lasts less than a frame.
- **Refuse to write a suspect measurement** (the row is packed ⇒ a width may be
  a squeeze ⇒ do not store it) livelocks a cold start: an over-full first pass
  is the only chance to learn any width at all, and refusing it means the fit
  never gets one.
- **Detect the squeeze at runtime and report it.** The fit's own arithmetic on
  the rendered row (`Σ measured + gaps + trigger`) exceeding `available` while
  `measureRowOverflow` reports zero *is* a sound detector — a deficit that
  vanished was absorbed by something the ledger cannot see. But it is rung 4
  (loud runtime failure) guarding an invariant this plan makes true at rung 1,
  it only catches *total* absorption, and it costs a new fault kind plus its
  reports plumbing. The build check below covers the same regression earlier and
  with no production code.

## Changes

### 1. The row is rigid — `web/internal/adaptive-bar.tsx`

`BAR_ROOT` becomes `min-w-0 flex-1 whitespace-nowrap [&>*]:shrink-0`, beside the
docstring that already explains why the bar's mechanics live in a module const.
The collapsed bucket is untouched: it measures nothing, so it has no axiom to
discharge.

### 2. `available` becomes the content box — same file

The border-box/content-box mismatch (`available` is
`getBoundingClientRect().width`, while `measureRowOverflow` compares against
`rect ± padding ± border`) is a separately-filed defect, and today flex hides
it: shrinkable occupants absorb the deficit until the spans sum to the content
box, so `overflowPx` returns 0 whatever padding the root carries. **This change
arms it** — after it, a consumer adding `px-xs` to a `panel` bar gets a
converged, `fits: true` row overflowing by exactly that padding, and
`failLoudly` throws in dev. No consumer does today, and it would be dishonest to
leave a trap this change set.

So `readColumnGap` becomes `readRowMetrics(root) → { gapPx, insetPx }` — one
computed-style read where there was one already — and `available` is
`measure(root) − insetPx`. In jsdom `getComputedStyle` returns `""`, `px()` maps
that to 0, and every existing expectation is unchanged.

### 3. The regression gate — a fixture that fails without the fix

`fixtures/internal/adaptive-bar-fixtures.tsx` gains a fixture built to be
squeezed: four occupants each holding a long `<Text>` label — the truncating
leaf that makes min-content small, and the shape no existing fixture has, since
all of them are made of accidentally-rigid buttons — in an ordinary `panel` bar
swept from roomy to far too narrow.

Its invariant is the harness's existing **`rigidIntegrity`** ("this slot's width
is stable across the width sweep"), which for these occupants reads exactly as
*the layout engine never took width from this one*. `checkRigidIntegrity` skips
widths where a slot is absent, so eviction at the narrow end is tolerated and
`noClip` + `noOverlap` come along as well.

`data-geo` is stamped onto the primitive's own `[data-adaptive-bar-item="<id>"]`
containers from the fixture in a layout effect — the same bridging idiom
`useTriggerGeoSlot` already uses for the `⋯` trigger — because the box that must
be proven rigid is the one the ledger measures, not the widget inside it.

### 4. …and a falsification, so the gate is proven to bite

The harness's own standard is that an invariant which cannot be falsified is
decoration (`expandRegionFixtures` supplies a mandatory `railOverride` for
exactly this reason). No existing `FixtureMutation` can re-enable shrink, so
`layout-harness` gains one generic kind — **`shrinkSlots`**: set
`flex-shrink: 1` on every `[data-geo]` box in the fixture subtree, i.e. *let the
engine take width from the measured boxes*. Paired with
`expectViolated: rigidIntegrity`, it reproduces today's broken shape and must
fail.

### 5. Prose

- `plugins/primitives/plugins/adaptive-bar/CLAUDE.md` — the ledger's axiom, the
  line that discharges it, and what it costs.
- `core/width-cache.ts` header — the axiom stated as enforced, with the pointer.
- `layout-harness/CLAUDE.md` — the new mutation kind.

## Files

| file | change |
|---|---|
| `plugins/primitives/plugins/adaptive-bar/web/internal/adaptive-bar.tsx` | `BAR_ROOT` rigidity; `available` as the content box |
| `plugins/primitives/plugins/adaptive-bar/web/internal/measure.tsx` | `readColumnGap` → `readRowMetrics` |
| `plugins/primitives/plugins/adaptive-bar/core/width-cache.ts` | header: the axiom and where it is discharged |
| `plugins/primitives/plugins/adaptive-bar/fixtures/internal/adaptive-bar-fixtures.tsx` | the squeezable fixture + `rigidIntegrity` + the falsification |
| `plugins/primitives/plugins/css/plugins/layout-harness/core/types.ts`, `web/internal/entry.tsx` | the `shrinkSlots` mutation |
| `plugins/primitives/plugins/adaptive-bar/CLAUDE.md`, `layout-harness/CLAUDE.md` | prose |

## Verification

1. `./equin test plugins/primitives/plugins/adaptive-bar` — the existing
   suites must be unchanged. jsdom has no layout engine and both engine-facing
   guards are gated on `useLayoutMeasured()`, so nothing there depends on flex
   behaviour or on computed styles.
2. `./equin check` — including `layout-geometry`, which builds the fixture
   page and sweeps it in headless Chromium.

   **Done, both directions, rather than assumed:**

   | run | result |
   |---|---|
   | fix present | 121 pass, 0 fail (the `shrinkSlots` falsification bites) |
   | `[&>*]:shrink-0` removed | 4 fail — `alpha/beta/gamma/delta` each 186.4px at 880 → 82.9px at 340 |
   | a bogus `rigidIntegrity` slot added | 1 fail naming `adaptive-bar/squeezable-occupants` — proof the fixture is in the catalog and its invariants are evaluated, not silently dropped |
3. `./equin build`, then on the deployed worktree:
   - `bun plugins/primitives/plugins/adaptive-bar/e2e/adaptive-bar-churn.ts
     --url http://<worktree>.localhost:9000/agents` — it already asserts *no
     occupant was ever squeezed while inline*, measured by toggling
     `flexShrink: 0` and comparing. That assertion is the whole of this task,
     driven across a continuous width sweep on a real route.
     Done: `apps-core.tab-bar#apps.tab-bar` swept 552–1392px, no squeeze, no
     page errors, no occupant rendered twice — on this branch and on `main`.
   - the app tab strip driven to 12 tabs at 760px on both deploys: identical
     down to the pixel (see above).
   - `query_db` for `kind = 'adaptive-bar'` reports on the worktree: a healthy
     sweep files nothing, and in particular no new `row-overflow`.

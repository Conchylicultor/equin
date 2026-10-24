# Layout: naming the two unnamed space-sharing roles (`yield` + `grow`)

**Date:** 2026-08-19
**Category:** global (css primitives, the lint rule + its check, the layout harness, ~33 consumer sites)
**Status:** plan, awaiting approval
**Parent:** [`2026-08-17-global-layout-primitive-corpus-gaps.md`](./2026-08-17-global-layout-primitive-corpus-gaps.md) — this is its
"**Grow-only and floor-only helpers**" follow-up, which said: *design this next to `rigidClass()`, not here.*

## Context

A flex child answers two independent questions: **does it take slack?** and **does it give below its own
content?** Today only two of the four answers have a name. `Rigid` (`shrink-0`) is the cell that gives
nothing; `Fill` (`min-w-0 flex-1`) is the cell that takes slack and gives everything. The other two
combinations have no spelling, so authors write the bare Tailwind class under a disable comment.

The shrink-only one is the loud one. Three files now carry prose describing the same missing role, in
their own words:

- `…/jsonl-viewer/plugins/collapsible-card/web/components/collapsible-card.tsx:189` — *"shrink-only cell: the
  aside must fall below its content width so the FilePath inside can start-ellipsize, but must NOT grow.
  `<Fill>`'s `flex-1` (basis 0) would hand the summary `<Text>` its full content width and squeeze the aside
  alone, instead of the two yielding together as they do today. Fill and Text are the only owners of
  `min-w-0` and both bundle grow/truncate with it, so bare `min-w-0` has no primitive."*
- `…/tool-call/plugins/workflow/web/components/workflow-tool-view.tsx:124` — same reason, same words, a
  different card.
- `plugins/primitives/plugins/breadcrumb/web/internal/breadcrumb.tsx:38` — *"the whole trail must fall below
  its content width so the prefix can truncate, but it must NOT grow into its parent's slack."* This one is a
  shared primitive with three consumers, so growing would push their sibling strip content.

The grow-only one is quieter but equally real. `…/data-view/plugins/view-core/web/components/editable-view-switcher.tsx:68`
spells it out: *"`flex-1` grows the switcher to absorb the toolbar's leading slack … min-width stays auto (no
`min-w-0`), so the view chips never truncate; they hug their content and only the trailing empty space grows."*
That is `flex-1` **without** `min-w-0` chosen deliberately — `Fill` would be wrong.

The sharpest single piece of evidence is `plugins/primitives/plugins/prompt-editor/web/components/prompt-editor.tsx:103`,
which already writes the two roles as a ternary — one of them has a helper and the other is a string literal:

```tsx
<div className={cn(asked ? fillClasses("x") : "min-w-0", dimmed)}>
```

The parent doc's measured sweep (real `Linter.verify()` over 6,658 files, not an estimate): **13 sites write
`min-w-0` alone, 20 write `flex-1` alone, and only 14 write the `min-w-0 flex-1` pair `fillClasses()` covers.**
`fillClasses()` is a drop-in for less than a third of the family it appears to serve, which is most of why it
had near-zero adoption.

**Intended outcome:** the four space-sharing roles all have names, the closed family is visible in one table,
the two new names are advertised by the lint message the moment someone types the raw class, and the ~33 sites
drain.

## The finding: the family is a closed 2×2, and `Fill` is a composition

| role | classes | axis param? | the question it answers |
| --- | --- | --- | --- |
| `Rigid` / `rigidClass()` | `shrink-0` | no | won't give at all |
| **`yieldClass(axis)`** | `min-w-0` \| `min-h-0` | **yes** | gives below its content, never takes slack |
| **`growClass()`** | `flex-1` | **no** | takes slack, floors at its own content |
| `Fill` / `fillClasses(axis)` | `flex-1 min-w-0` | yes | **= grow + yield** |
| *(no class — the default)* | — | — | gives down to its content, takes nothing |

Two properties fall out of this table and both are load-bearing:

- **`fillClasses` is literally `growClass()` + `yieldClass(axis)`.** Deriving it (Stage 2) makes the pair
  unable to drift from its halves — rung 1, not a doc note.
- **The axis asymmetry is explained, not arbitrary.** `Yield` and `Fill` take an axis because `min-width:0`
  and `min-height:0` are two different properties; `Rigid` and `Grow` do not, because `flex-shrink` /
  `flex-grow` are single properties that already follow whichever axis the container declared as main.
  `rigid/CLAUDE.md` currently documents that asymmetry as a two-primitive quirk ("do not 'fix' it"); after
  this change it is a column of the table.

**Helpers only — no `<Yield>` / `<Grow>` components.** Every one of the 33 attested sites is a `className` on a
box the author *already* owns (a `Stack`, a `Line`, a `Text`, or a pass-through `className` prop) — zero
wrapper cases. And unlike `Rigid`, neither role has a spacer idiom to claim: an **empty `<Fill>`** is already
the sanctioned growing spacer (identical output, since `min-w-0` is a no-op on an empty box), and a contentless
yield box is a no-op by definition. Ship the components later if the drain surfaces a real wrapper site.

## What lands, in order

### Stage 1 — the two plugins

Two new sibling plugins, each mirroring `css/plugins/rigid` byte-for-byte in shape (`package.json`,
`web/index.ts` barrel, `web/internal/<name>.tsx`, a co-located `*-classes.test.ts`, a hand-written `CLAUDE.md`):

- **`plugins/primitives/plugins/css/plugins/yield/`** → `yieldClass(axis: YieldAxis): string` and
  `export type YieldAxis = "x" | "y"`. Emits `min-w-0` / `min-h-0`.
- **`plugins/primitives/plugins/css/plugins/grow/`** → `growClass(): string`. Emits `flex-1`. No axis
  parameter, for the same reason `rigidClass()` has none — say so in the test, as `rigid` does.

Note for the `grow` docs: the neighbouring `css/plugins/grow-relay` is the grow **request** (who asks a row
for room and who relays the ask); `grow` is a box that takes slack unconditionally. Cross-link both ways so
nobody conflates them.

`YieldAxis` is declared in `yield`, not shared with `fill`'s existing `FillAxis` — `fill` will import `yield`
(Stage 2), so pulling the type the other way would cycle. `FillAxis` has **no namers outside its own plugin**
(verified), both are `"x" | "y"`, and the risky drift direction is already a tsc error: if `FillAxis` ever
gained a member, passing it to `yieldClass()` would fail to compile.

### Stage 2 — derive `fillClasses` from its halves

```ts
// plugins/primitives/plugins/css/plugins/fill/web/internal/fill.tsx
export function fillClasses(axis: FillAxis): string {
  return `${yieldClass(axis)} ${growClass()}`;
}
```

Yield first, grow second, so the emitted string stays **byte-identical** to today's `"min-w-0 flex-1"` and no
test, snapshot, or rendered surface changes. Add one assertion to `fill-classes.test.ts` pinning the
composition itself (`fillClasses("x") === \`${yieldClass("x")} ${growClass()}\``) so the algebra in the table
above is a test, not prose. The new cross-plugin edges `fill → yield` and `fill → grow` are DAG-safe (both new
plugins are leaves importing only `ui-kit`'s `cn`).

### Stage 3 — advertise them (the forcing function is already in place)

`css:message-names-primitives` (`plugins/primitives/plugins/css/check/index.ts`) partitions the
`css/plugins/*` **directory listing** and is fail-closed: a new directory is a layout mechanic until declared
otherwise, so **the check goes red the moment Stage 1 lands** and stays red until the message names both. That
is the intended sequence — no separate reminder needed.

- `plugins/primitives/plugins/css/lint/no-adhoc-layout.ts` — extend the `space-sharing` line of the
  `adhocLayout` message and the class-string escape list:

  ```
  space-sharing  <Fill> — THE grow+shrink cell (min-w-0 flex-1) · <Rigid> — THE leaf that never shrinks (shrink-0)
                 · yieldClass(axis) — gives below its content, never grows (min-w-0) · growClass() — takes slack,
                   floors at its content (flex-1) · <Text> in a line container — THE truncation leaf
  ```

  …and `take the class string instead: fillClasses(axis), rigidClass(), yieldClass(axis), growClass(), layerClasses(…), insetClass(step)`.
  Also update the rule's own docstring (same list) and the `grow-relay` entry in the check's
  `NOT_A_LAYOUT_MECHANIC`, whose reason still reads *"The box you reach for is Fill"*.

  Checked: the check's `namesPrimitive` matcher is word-boundary and case-sensitive, so `\bGrow\b` does not
  match inside `GrowRelay` and vice-versa — no false pass, no false contradiction.

- `plugins/primitives/plugins/css/CLAUDE.md` — replace the one-line space-sharing row with the 5-row table
  above (it is the whole point of the change).
- `plugins/primitives/plugins/css/plugins/fill/CLAUDE.md` — state that `Fill` **is** grow + yield, and add the
  one line that answers the collapsible-card question: *two siblings that must yield together both take
  `yieldClass`; `Fill`'s basis-0 hands one of them its full content width and squeezes the other alone.*
- `plugins/primitives/plugins/css/plugins/rigid/CLAUDE.md` — its "missing half of `<Fill>`" framing is now the
  corner of a table; re-cut that section and point at the table.
- `.claude/skills/css/SKILL.md` — the mental-model bullet *"`min-width: 0` … Two primitives own it"* is the
  sentence this change falsifies; rewrite it around the table, and add both helpers to the class-string
  paragraph and the primitive index.

### Stage 4 — make the reason-for-existing checkable (layout-harness)

The three disable comments all assert a *geometry* claim — "Fill would squeeze the aside alone" — that nothing
verifies. The harness is where that becomes a gate. One `fixtures/index.ts` under `yield` (a collected dir; codegen
picks it up with zero registry edits) with a `<Line>` holding a `<Text>` summary and a long-path aside carrying
`yieldClass("x")`, swept across widths. This needs two small additions to the harness core:

- **A new `GeometryInvariant`, `{ kind: "truncatesTogether"; slots: string[] }`** — at every swept width,
  either all listed slots truncate or none does. `truncationOnsetOrder` cannot express this: it requires
  *strict* priority (`onset(first) > onset(last)`), which is the opposite of what yielding together means.
  ~15 lines in `core/oracle.ts`, following `checkNeverTruncatesWhenRoomy`'s shape.
- **A new `FixtureMutation`, `{ kind: "swapSlotRole"; slot: string; role: "grow" | "yield" | "fill" | "rigid" }`**
  — re-declares one measured slot as a different space-sharing role. Deliberately role-shaped rather than
  mechanic-shaped, so it covers every wrong-role falsification in the family with one addition. The yield
  fixture's falsification is `swapSlotRole` → `"fill"` expecting `truncatesTogether` **violated** — i.e. it
  reproduces exactly the mistake the three disable comments warn about, and proves the fixture can tell the
  difference. A `grow` fixture then reuses it in the other direction: `swapSlotRole` → `"fill"` on the
  switcher's growing box, expecting `rigidIntegrity` on the chips violated (they crush once a floor is added).

This stage is separable — Stages 1–3 and 5 do not depend on it — but it is what turns "Fill is wrong here"
from a comment in three files into something the build knows.

### Stage 5 — drain

Re-measure first with the parent doc's methodology (a real `Linter.verify()` sweep with every contributed rule
loaded), since the 13/20 counts are from 2026-08-17 and the corpus moves ~25 directives/month. Then, per site,
replace the raw class with the helper and **delete the disable directive** — do not leave it, and note that
`css/plugins/**` is already permanently allowlisted, so no allowlist edit is needed for the new plugins.

Migration order, cheapest-first (each is a one-line change to a box that is already a primitive):

1. `prompt-editor.tsx:103` — the ternary becomes `asked ? fillClasses("x") : yieldClass("x")`. One line, and
   it is the clearest demonstration in the repo of what landed.
2. The **two-line truncating label cell** — the single most repeated shape, five near-identical sites, all
   `<Stack gap="2xs" className="min-w-0">` wrapping two `<Text className="truncate">` lines inside a `Row` or a
   data-table cell: `debug/profiling/plugins/runtime/…/runtime-section.tsx:180`,
   `debug/slow-ops/plugins/cluster/…/cluster-view.tsx:73`, `debug/slow-ops/plugins/pane/…/slow-ops-view.tsx:103`,
   `history/plugins/dialog/…/version-history-dialog.tsx:78`, `search/plugins/quick-find/…/quick-find-dialog.tsx:187`.
3. The three sites that document the gap in prose — `collapsible-card.tsx:190`, `workflow-tool-view.tsx:125`,
   `breadcrumb.tsx:38`. Their disable comments are the plan's evidence; deleting them is the plan's receipt.
   `breadcrumb` has three consumers, so screenshot it (Stage 6) rather than trusting the diff.
4. The `flex-1`-alone set, which needs a judgement per site and is **not** uniformly `growClass()`:
   `editable-view-switcher.tsx:68` and the ultimate-guitar URL input are genuine grow-only; the contentless
   Gantt/timeline tracks, the `h-px flex-1` hairlines in `summary-row.tsx`, and the `boot-profile-live.tsx:44`
   spacer are all cases where `<Fill>` / `fillClasses()` was already correct and simply never reached for
   (`min-w-0` is a no-op with no content to floor) — migrate those to `Fill`, not to `Grow`. Leave
   `miller/column.tsx` raw: its grow/shrink choice is computed per render.

Sites under `plugins/primitives/plugins/css/plugins/**` are permanently allowlisted and out of scope.

## Rejected

- **A typed `space?: "rigid" | "yield" | "grow" | "fill"` prop threaded through the layout primitives.** It
  looks like the higher rung, but it isn't: `no-adhoc-layout` already bans the raw classes, so a prop and a
  helper are enforced at exactly the same rung — the prop just costs an edit to ~15 primitives and reverses a
  design shipped two days ago with stated reasons. If the whole family (`rigid`/`fill`/`yield`/`grow`) should
  become props, that is one coherent proposal to make later, not half of it bolted on now.
- **A single `space` plugin owning all four roles.** The governing precedent is `clip`/`scroll` and
  `fill`/`rigid`: one primitive per mechanic, kept as siblings. `rigid/CLAUDE.md` argues this explicitly —
  `Stack`/`Inset` cohabit only because they share the `SpaceStep` ramp, and these four share no data.
- **`<Yield>` / `<Grow>` components** — see above; zero of 33 sites want a wrapper, and both spacer idioms
  already belong to an empty `<Fill>`.

## Verification

- **Pure:** `./equin test plugins/primitives/plugins/css/plugins/yield` and `…/grow` and `…/fill` — the
  new class tests plus the composition assertion in `fill-classes.test.ts`.
- **Geometry:** `./equin check layout-geometry` — the yield fixture across the width sweep, and the
  `swapSlotRole` falsification asserting `truncatesTogether` actually bites. (The harness check keys its cache
  on the whole `css/plugins/**` tree, so it re-runs by itself and launches no browser when untouched.)
- **The advertising gate:** `./equin check css:message-names-primitives` — red between Stage 1 and Stage
  3 by construction, green after.
- **Whole gate:** `./equin check` — `eslint` (every drained directive must be **gone**; a leftover one is
  itself an error), `type-check`, `plugins-doc-in-sync`, `plugins-registry-in-sync`.
- **Visual, after the drain:** `./equin build` (background, then end the turn), then
  `plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts` against the surfaces whose
  space-sharing changed — a conversation with a tool card (collapsible-card + workflow summary at a narrow
  pane width, which is where the aside-vs-summary split is visible), Debug → Slow Events and Debug → Profiling
  (the two-line label cells), and a `filepath-breadcrumb` consumer. Narrow the pane in each; the whole claim
  is about behaviour under pressure, so a wide screenshot proves nothing.

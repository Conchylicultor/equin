# Rows align their icon to a box that is taller than its text

## Context

A user pointed at the conversation toolbar's **Artifacts** popover: "the icon and
text are not aligned. This seems to be a recurring UI issue." And: "text size
feels too large," compared against the mock `proto-1789731211-jeis`.

Both complaints are real, they are **two independent defects**, and only one of
them is about the artifacts panel. Measured against the running app
(`equin.localhost:9000`, the row "Live subagent transcripts"):

| | measured |
| --- | --- |
| title font size / line-height | **16px / 24px** — the document root size, in a panel whose heading is 12px |
| the `<Text>` leaf's own box | 24px tall |
| the `<Fill>` cell holding it | **30px tall** |
| icon centre (y) | 194.0 |
| text cap-height centre (y) | 191.0 |
| **icon sits below the text by** | **3.0px** |

### Defect 1 — the cell lies about its height (the recurring one)

`Text`, inside a single-line container, applies
`singleLineLeafClass()` = `"inline-block max-w-full min-w-0 truncate"`
(`plugins/primitives/plugins/css/plugins/text/web/internal/text.tsx:97`).

`truncate` sets `overflow: hidden`, and **an inline-block whose overflow is not
`visible` takes its bottom margin edge as its baseline**. So when that leaf sits
in a plain block box — which `<Fill>` is (`min-w-0 flex-1`, `display: block`) —
the parent's line box must still fit the *strut's* descent **below** that
baseline. The cell comes out ~6px taller than the text it contains, and the
row's `items-center` then centres every sibling against that inflated box:
the icon lands half the phantom space too low.

This is the canonical row recipe the `css` skill itself teaches —
`Line > Icon + Fill(Text) + trailing`. `rg '<Fill>\s*\n\s*<Text'` finds **72
sites**: mail thread rows, the health-report panel, event rows, the timeline,
the chord trainer, the website improve panel, the artifacts row. Every one of
them is ~6px too tall and misaligns its own icon. Rows that put `<Text>`
*directly* in the flex row (the DataView list view does) are already correct —
which is why this reads as an occasional, hard-to-name wrongness rather than an
obvious repo-wide bug.

It is the `Badge` baseline incident one layer up
(`plugins/primitives/plugins/css/plugins/badge/web/internal/badge.tsx:110-141`:
"carried the label about 3.5px higher than the words beside it"). That one was
cured at the call site with `self-baseline`; this one has never been named, and
**no test, lint rule or geometry fixture in the repo can currently see it** —
`GeometryInvariant` has nine kinds and none of them is about vertical placement.

### Defect 2 — the title has no declared type size

`<Text>`'s `variant` is optional, and omitting it means "inherit the surrounding
typography." In a popover nothing declares a rung, so "inherit" resolves to the
document root: **16px**. `ArtifactRow` omits it, which is the whole of the
"text feels too large" complaint. `Row` would have declared the rung
(`text-caption` / `text-body`, `row.tsx:296`) — but `ArtifactRow` hand-rolls its
row out of `Line`, so it also misses `Row`'s `icon-auto` glyph sizing, its hover
tint and its focus ring.

### What the fix must achieve

Verified in the live app by injecting each candidate and re-measuring:

| variant | cell height | icon-to-text offset |
| --- | --- | --- |
| as shipped | 30px | **3.01px** |
| fix the font size only (13px/20px) | 26px | **2.88px** — unchanged |
| leaf stops participating in inline layout | 24px | **0.01px** |
| `Fill` becomes a flex cell | 24px | **0.01px** |

So fixing the size does **not** fix the alignment; they are separate, and the
row also gets ~6px shorter once the phantom space goes (34px → 28px, which is
about the mock's density).

## Approach

Four phases. Phases 1–3 are the fix and its gate; phase 4 is separable and can
be dropped without weakening them.

### Phase 1 — the leaf stops sinking its parent's line box

`singleLineLeafClass()` (`…/css/plugins/text/web/internal/text.tsx:97`) becomes a
**block-level, shrink-to-fit** box:

```ts
return "block w-fit max-w-full min-w-0 truncate";
```

- `block` removes the inline formatting context, so the parent has no strut and
  its height is exactly the leaf's. This is exact for **every** font-size
  combination, unlike `vertical-align: top`, which only helps while the leaf's
  line-height is at least the parent's.
- `w-fit` keeps the shrink-to-fit width `inline-block` gave it, so a
  `hover:underline` or a background still ends where the words end
  (`plugins/page/plugins/sub-page/web/components/sub-page-block.tsx:133` is the
  one live width-sensitive site). Without it, a block leaf would span the cell.
- `max-w-full` + `min-w-0` + `truncate` are unchanged, so the ellipsis behaves
  exactly as before.

**Why not change `Fill` instead.** Making `Fill` a flex cell measures equally
well, but the audit found the blast radius is much larger: 23 `<Fill as="span">`
sites that are inline text runs mid-line, an `as="hr"` and an `as={Clip}`, 18
`<Fill><Stack>` bodies (mail thread rows, message cards, health rows) whose
child would go from natural block flow to a centred flex item, and
`plugins/apps/plugins/website/plugins/shell/web/components/website-page.tsx:18`
wrapping an entire page body. It would also split `<Fill>` from `fillClasses()`,
whose identity (`fillClasses(axis) === yieldClass(axis) + " " + growClass()`) is
documented and pinned by `fill-classes.test.ts`.

**Verify before committing to `w-fit`.** `block w-fit` must be measured, not
assumed: confirm the ellipsis still appears on a long title, that a `<Text>`
which *is* a flex item is unchanged (flex items are blockified either way), and
that `side="start"` (the RTL branch, same class string, `text.tsx:172`) behaves
identically. If `w-fit` interferes with flex sizing anywhere, fall back to plain
`block` and give the one underline site a `w-fit` of its own.

Existing tests are additive-safe: `single-line.test.tsx` asserts membership of
`min-w-0` / `truncate` / `max-w-full` via `classList.contains` and, at lines
34-37 and 58-59, `inline-block` — **those two assertions change to `block`**, and
the comment explaining why the recipe exists (`text.tsx:84-96`) gains the
baseline reason.

### Phase 2 — a gate so it cannot come back

The harness at
`plugins/primitives/plugins/css/plugins/layout-harness` renders real components
with real Tailwind and measures them in Chromium, but it can only express
horizontal claims. Add the vertical one:

1. **Measure it.** `MeasuredFixture["slots"]` (`layout-harness/core/types.ts`)
   gains a per-slot optical centre: for a text box, the midpoint of cap-top and
   baseline, derived from canvas `TextMetrics`
   (`actualBoundingBoxAscent` + `fontBoundingBox*`) as the diagnostic script did;
   for an `<svg>`, the centre of its ink box (`getBBox()` mapped through the
   `viewBox`). Computed in `web/internal/entry.tsx` beside `box()`, where the
   real DOM is.
2. **Assert it.** A new `GeometryInvariant` kind —
   `{ kind: "opticalCenter"; slots: string[]; epsilon?: number }` — every named
   slot's optical centre agrees within ~0.75px, at every width in the sweep.
   One pure function in `core/oracle.ts` plus its arm in `evaluateInvariant`,
   with passing and failing cases in `oracle.test.ts` like every other kind.
3. **A fixture that is the bug.** Extend
   `plugins/primitives/plugins/css/plugins/text/fixtures/internal/text-fixtures.tsx`
   with the canonical row — `Line > svg + Fill(Text) + trailing mark` — asserting
   `opticalCenter` over the glyph and the title. Its falsification is the
   construct being removed: the existing `swapLeafDisplay` mutation
   (`types.ts:146`) set to `inline-block`, which must violate `opticalCenter`.
   That is what proves the gate has teeth rather than merely observing that the
   fixed layout agrees with itself.

This is the rung that makes the *class* non-recurring: any future cell that
re-inflates its height fails `./equin check`.

### Phase 3 — the artifacts popover, on the primitive that owns this shape

`plugins/conversations/plugins/conversation-view/plugins/artifacts/web/components/artifact-row.tsx`
hand-rolls an interactive row out of `Line` + a raw `<Icon className="size-4">` +
a variant-less `<Text>`. It is exactly what `Row` is for. Rewrite it as:

```tsx
<Row
  icon={<Icon className="text-muted-foreground" />}   // no size — Row's icon-auto sizes it from the row's own rung
  onClick={…}
  hover="muted"                                        // the popover/card tint
  title={`${item.key}\n${detail}`}
  disabled={…}
>
  <Fill>
    <Text variant="body" tone={referenced ? "muted" : "default"}>{title}</Text>
  </Fill>
  <RelationMarker relation={item.relation} />
</Row>
```

What this buys, beyond the size: `Row` declares the type rung, auto-sizes any
bare glyph (`[&_svg:not([class*='size-'])]:icon-auto`, `row.tsx:296`), paints the
canonical focus ring, and owns `p-row` padding — four things the hand-rolled row
was re-deriving or missing. Drop the `rigidClass()` on the icon (`Row`'s leading
slot is already rigid) and the hand-written hover/disabled classes.

The row keeps `RelationMarker` in its body rather than in `actions`: the mark is
presentational state, not an action, and `actions` is hover-revealed.

While here, `artifacts-panel.tsx` and the per-kind sections
(`plugins/…/artifacts/plugins/*/web/`) should be checked for the same
variant-less `<Text>`; the panel header already uses `variant="label"`.

Compare the result against the mock with the prototype harness rather than by
eye:
`./equin run plugins/apps/plugins/prototypes/plugins/compare/e2e/compare-diff.ts --name proto-1789731211-jeis`.

### Phase 4 (separable) — close the "no size chosen" hole

Defect 2's root is that omitting `variant` is indistinguishable from choosing to
inherit. There are ~70 variant-less `<Text>` sites; the ones inside a `Row` are
fine (the row declares the rung), and the ones inside a bare `Line` or a panel —
like this one — silently render at 16px.

Make `variant` **required**, with an explicit `variant="inherit"` for the
deliberate cases (`TextVariant` gains the member; `VARIANT_CLASS["inherit"]` is
the empty string, so behaviour is unchanged where it is chosen on purpose).
"No size chosen" becomes a compile error — rung 2 of the fix ladder, where today
it is nothing at all. The cost is visiting ~70 call sites, and some of those
visits will turn up more size bugs like this one.

Drop this phase and phases 1–3 still stand; it is the difference between fixing
the rows that are wrong today and making the mistake unspellable.

## Files

| file | change |
| --- | --- |
| `plugins/primitives/plugins/css/plugins/text/web/internal/text.tsx` | `singleLineLeafClass()` → block-level; the comment gains the baseline reason. Phase 4: `variant` required + `"inherit"`. |
| `…/css/plugins/text/web/__tests__/single-line.test.tsx` | two `inline-block` assertions → `block`, plus a case pinning the new box type |
| `…/css/plugins/text/CLAUDE.md` | the recipe is quoted verbatim at line 78 and the fixture named at 90 — both need updating |
| `…/css/plugins/layout-harness/core/types.ts` | per-slot optical centre on `MeasuredFixture`; new `opticalCenter` invariant kind |
| `…/css/plugins/layout-harness/core/oracle.ts` + `oracle.test.ts` | the invariant function and its own passing/failing proof |
| `…/css/plugins/layout-harness/web/internal/entry.tsx` | measure cap-centre / ink-centre beside `box()` |
| `…/css/plugins/text/fixtures/internal/text-fixtures.tsx` | the canonical row fixture + its `swapLeafDisplay: "inline-block"` falsification |
| `…/conversations/…/artifacts/web/components/artifact-row.tsx` | rebuilt on `Row` |
| `.claude/skills/css/SKILL.md` | the worked example teaches `Line > Icon + Fill(Text)`; add the one sentence saying why the leaf is block-level |

## Verification

1. `./equin build`, then `./equin check` — the new geometry
   invariant and its falsification run here, and the falsification failing to
   fail is itself a failure.
2. `./equin test plugins/primitives/plugins/css/plugins/text` and
   `…/layout-harness`.
3. Measure the real row again, the same way the defect was found: drive the
   deployed app to the artifacts popover and read back the icon's ink centre and
   the title's cap centre. Expect the offset at ~0px (from 3.01px) and the row
   at 28px (from 34px). This belongs in the plugin as
   `plugins/conversations/…/artifacts/e2e/` rather than as a throwaway.
4. Screenshot the widest blast radius by hand — mail thread rows, the
   health-report panel, the timeline detail strip, the chord trainer — before
   and after, since all of them lose ~6px per row.
5. `compare-diff.ts` against `proto-1789731211-jeis` for the artifacts panel
   itself.

## What this deliberately does not do

- It does not change `Fill`, for the blast-radius reasons above. If the optical
  gate later catches a cell that is not a `<Text>` leaf (a third-party inline
  component inside a `Fill`), that is the moment to revisit it — the gate will
  name the site instead of a user noticing it looks off.
- It does not touch `icon-auto`'s lint rule, whose parent allowlist still covers
  only five primitives. Rebuilding the artifacts row on `Row` removes that call
  site's hardcoded `size-4`; broadening the rule to any line container is its own
  task.

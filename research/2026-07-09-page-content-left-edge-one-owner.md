# One owner for the page content-left edge

## Context

On a page-detail pane the page title's text starts at a different x than the block
text below it — 416px vs 412px in a 1280px viewport. The `BLOCK_GUTTER` doc comment
in `plugins/page/plugins/editor/web/components/block-row.tsx` asserts the opposite
("the title text and block text share one content-left edge"). It is not true today,
and the comment is wrong in a second way too: the page icon does *not* live in the
rail, it sits on the content edge next to the title.

The 4px gap is a coincidence, not a design. Measuring from the reading measure's left
edge (`M`, x=336 in the repro), three surfaces each derive their own edge:

| surface | left | right margin |
|---|---|---|
| page title | `M` + 16 (`px-lg`) + 64 (`BLOCK_GUTTER`) = **M+80** | 64 |
| block text | `M` + 0 (`px-lg` zeroed) + 64 (row rail) + 12 (`pl-md`) = **M+76** | 76 |
| section list (backlinks, blog-publish, story) | `M` + 16 = **M+16** | 80 |

Two independent errors nearly cancel: the header keeps the measure's `px-lg` (16px)
while the block editor zeroes its left padding, and the block text carries a 12px
inset the title lacks. Net 4px. Both offsets are density-scaled (`--space-lg`,
`--space-md`) while `BLOCK_GUTTER` is a fixed 64px, so the residual gap also changes
with the density preset. Meanwhile the section list is 60px left of the title,
aligned with nothing.

The same class of bug exists on the read-only surfaces: the public blog post pane
(`blog-post.tsx`) and the version-history preview dialog (`page-version-preview.tsx`)
both render a flush-left title as a plain sibling of `<ReadOnlyBlocks>`, whose text
rows carry their own `pl-md`.

Intended outcome: exactly one place owns the geometry, so no host — present or future
— can compute the content edge from `BLOCK_GUTTER` plus whatever padding its wrapper
happens to carry.

## The invariant

Reading the block types settles the open question of where the 12px belongs. It is
**not** text-block-specific: `image`, `divider`, `code-block` and `callout` each
already wrap themselves in `px-md`, and `read-only-view` re-declares the same 12px
five more times. It is the universal inset between a block's *decoration* and its
*content*.

> A page's **block content box** has a left edge `C`.
> - Block **decorations** start at `C`: the quote's left border, the callout tint,
>   the code background, the image, the divider rule, the selection highlight, the
>   diff rail.
> - Block **content** (text, media) insets from `C` by `BLOCK_INSET`.
> - Anything a host renders *alongside* blocks that is not itself a block — the page
>   title, the page icon, the section list — sits at `C + BLOCK_INSET`.

The editable surface puts the hover rail (`BLOCK_GUTTER`) to the *left* of `C`, inside
each row's own padding (so the pointer can reveal the controls — unchanged). The
read-only surface has no rail, so `C` is simply the renderer's left edge. The inset is
shared by both.

Consequence: **blocks do not move.** The title moves 4px left onto the block text
edge, and its right margin becomes symmetric (76/76 instead of 80/64).

## Design

Move the column geometry out of `block-row.tsx` / `block-text-editor.tsx` into one
internal module, and expose an API that makes the arithmetic unreachable from hosts.

**New: `plugins/page/plugins/editor/web/internal/page-column.ts`** — the single
declaration site.

```ts
/** Rail width: hover controls hang into it at -20/-40/-60 from the content edge. */
export const BLOCK_GUTTER = 64;
/** Per-depth indent of a nested block's content box. */
export const BLOCK_INDENT = 24;
/** Decoration-edge → content-edge inset. Every block's content sits here. */
export const BLOCK_INSET: SpaceStep = "md";
/** Fixed leading-marker column (bullet / number / checkbox / callout icon). */
export const MARKER_GUTTER = "1.5rem";
```

**New: `plugins/page/plugins/editor/web/components/page-content-column.tsx`**

```tsx
/** Puts a host's own chrome (page icon, title, section list) on the block content edge. */
export function PageContentColumn({ children, className }) {
  return (
    <div style={{ paddingLeft: BLOCK_GUTTER, paddingRight: BLOCK_GUTTER }}>
      <Inset x={BLOCK_INSET} className={className}>{children}</Inset>
    </div>
  );
}
```

**Barrel (`plugins/page/plugins/editor/web/index.ts`)**: export `PageContentColumn`,
`BLOCK_INSET`, `BLOCK_INDENT`, `MARKER_GUTTER`. **Stop exporting `BLOCK_GUTTER`** — it
becomes editor-internal, which is what structurally prevents a host from re-deriving
the edge. (Its only two cross-plugin consumers are replaced below.)

`Inset` (`@plugins/primitives/plugins/css/plugins/spacing/web`) already supports a
per-axis `x` prop, and named ramp steps pass `no-adhoc-spacing`; inline `style`
padding does not trip `no-adhoc-layout` (it only inspects `position`).

### Editable surface — `plugins/apps/plugins/pages/plugins/page-tree/web/`

- `panes.tsx`: `READING_MEASURE` drops `px-lg` → `"mx-auto w-full max-w-4xl"`. The
  rail + inset (76px) already supply the narrow-pane margin; keeping `px-lg` is what
  made the header's rail origin differ from the editor's. Wrap the `PageHeader` and
  the `PageDetail.Section.Render` in `<PageContentColumn>` instead of hand-applying
  `paddingRight: BLOCK_GUTTER`.
- `components/page-header.tsx`: delete `style={{ paddingLeft: BLOCK_GUTTER }}` and the
  `BLOCK_GUTTER` import. The header keeps only `pt-lg`.
- `plugins/page/plugins/editor/web/components/block-editor.tsx`: the content wrapper
  keeps `style={{ paddingLeft: 0, paddingRight: BLOCK_GUTTER }}`, but the comment is
  rewritten: the wrapper owns the horizontal gutters, `contentClassName` supplies
  width/centering only. (With `px-lg` gone the `paddingLeft: 0` is inert, but it keeps
  the wrapper's geometry independent of a caller-supplied class.)
- `block-row.tsx`: unchanged behaviour; imports the constants and gets a corrected
  `BLOCK_GUTTER` doc comment stating the invariant above (and dropping the false claim
  that the header reserves the rail for the page icon).

Resulting geometry, all three surfaces: content-left `M+76`, content-right `M+W-76`.

### Blocks — collapse the five re-declarations onto the token

Replace the hard-coded `px-md` / `pl-md` / `pr-md` with `<Inset x={BLOCK_INSET} …>`
(or `BLOCK_INSET` threaded into the existing `Inset`), so a new block type has one
named thing to reach for:

- `plugins/page/plugins/editor/web/components/block-text-editor.tsx` — `pl-md` on the
  flex row, `pr-md` on the `ContentEditable`. Keep `py-xs` and the `inset` prop as-is
  (callout still passes `inset={false}`; its tint box owns the inset).
- `plugins/page/plugins/{image,divider,code-block,callout}/web/components/*.tsx` —
  each `px-md` wrapper. Vertical padding differs per block (`py-xs` vs `py-sm`) and
  stays untouched.

No visual change: same value, one name.

### Read-only surface

`plugins/page/plugins/read-only-view/web/components/read-only-blocks.tsx` currently
mirrors the editor by hand. Have it import the real constants:

- `MARKER_GUTTER` — delete the local copy (line 34), import from the editor.
- The nested-children indent is `pl-md` (12px) where the editor uses `INDENT` (24px).
  Switch to `style={{ paddingLeft: BLOCK_INDENT }}`. **This is a visible fidelity
  fix** — nested blocks in blog posts and history previews currently indent half as
  far as in the editor.
- The per-block `pl-md` / `px-md` / `pr-md` become `BLOCK_INSET`, same as the editor's.

Then the two hosts put their title on the content edge (`C + BLOCK_INSET`), with the
blocks staying flush at `C` so decorations and diff rails keep their bleed:

- `plugins/apps/plugins/website/plugins/blog/plugins/site/web/components/blog-post.tsx`
  — wrap the title/date/summary `Stack` (and the `<div className="border-b" />`? no —
  the rule should stay full-measure) in `<Inset x={BLOCK_INSET}>`.
- `plugins/apps/plugins/pages/plugins/history/web/components/page-version-preview.tsx`
  — wrap the icon+title row in `<Inset x={BLOCK_INSET}>`.

These two get `BLOCK_INSET` from the editor barrel (both already import from
`@plugins/page/plugins/editor/*`, so no new dependency edge and no cycle).

## Critical files

| file | change |
|---|---|
| `plugins/page/plugins/editor/web/internal/page-column.ts` | **new** — the four constants |
| `plugins/page/plugins/editor/web/components/page-content-column.tsx` | **new** — `PageContentColumn` |
| `plugins/page/plugins/editor/web/index.ts` | export the new API; drop `BLOCK_GUTTER` |
| `plugins/page/plugins/editor/web/components/block-row.tsx` | import constants; fix the doc comment |
| `plugins/page/plugins/editor/web/components/block-editor.tsx` | rewrite the wrapper comment |
| `plugins/page/plugins/editor/web/components/block-text-editor.tsx` | `BLOCK_INSET`, `MARKER_GUTTER` |
| `plugins/page/plugins/{image,divider,code-block,callout}/web/components/*.tsx` | `BLOCK_INSET` |
| `plugins/page/plugins/read-only-view/web/components/read-only-blocks.tsx` | import constants; 12→24 indent |
| `plugins/apps/plugins/pages/plugins/page-tree/web/panes.tsx` | drop `px-lg`; `PageContentColumn` ×2 |
| `plugins/apps/plugins/pages/plugins/page-tree/web/components/page-header.tsx` | drop `paddingLeft` |
| `plugins/apps/plugins/website/.../blog/plugins/site/web/components/blog-post.tsx` | inset the title |
| `plugins/apps/plugins/pages/plugins/history/web/components/page-version-preview.tsx` | inset the title |
| `plugins/page/plugins/editor/CLAUDE.md` | document the invariant |

## Why no regression test

There is nothing to assert against: jsdom has no layout, and no existing test or check
touches these constants. The guarantee is structural instead — after this change the
title, the sections and the block text all resolve their left edge from the same
`PageContentColumn` / `BLOCK_INSET`, and `BLOCK_GUTTER` is no longer reachable from
any host. A host *cannot* express the old arithmetic. That is the intended fix; a
pixel test would only re-check what the type system now makes unreachable.

## Verification

1. `./equin build`
2. Measure the real edges (the numbers in the Context table are the "before"):

```bash
bun e2e/screenshot.mjs --url http://att-1783596865-5lfy.localhost:9000/pages --out /tmp/pages
```

Then a scripted Playwright run on a page with at least one text block, one nested
block, a quote and a callout, evaluating in-page:

- `input.page-doc-title` → `getBoundingClientRect()`
- first block's `[contenteditable]` → `getBoundingClientRect()`
- the `PageDetail.Section` container → `getBoundingClientRect()`

Assert all three `.left` are equal, and that the title's `.right` equals the block
text's `.right`. Expect **412** for all (blocks unmoved, title −4, sections +60) at a
1280px viewport.

3. Repeat with a non-default density preset (Settings → Appearance → cozy/compact) to
   confirm the edges still coincide — this is what proves the density-scaled inset is
   now shared rather than applied on one side only.
4. Open a nested page in the version-history dialog and a published blog post: title
   sits on the block text edge; the quote border and diff rails still bleed left to
   `C`; nested blocks indent 24px.
5. Hover a block row and drag from the far-left whitespace — the `+` / drag / chevron
   controls must still reveal (the rail stays inside each row's box).
6. `./equin check` — `plugins-doc-in-sync` will need the regenerated docs from
   step 1 (the editor's public exports change).

## Addendum — one deviation from the plan, and why

Threading `BLOCK_INSET` into a class name required a template literal
(`` `pl-${BLOCK_INSET}` ``). That is **wrong**: `pl-md` is a Tailwind v4 `@utility`,
emitted only when the scanner finds its literal token. The class survived solely
because `pl-md` happened to be spelled out in another file — the same species of
accidental coincidence this whole change exists to remove, and invisible until some
unrelated edit deleted the last literal. (The repo already has a
`tailwind-scan-covers-classes` check, which is what would eventually have caught it.)

Root cause: `primitives/css/spacing` is "the sanctioned home for layout rhythm" but
only exported the `<Inset>` **component**, so any consumer that can only pass a
`className` — Lexical's `<ContentEditable>`, `<Text>`, third-party props — had no way
to reach the ramp and hand-wrote `pl-md`, which meant the step could never be a
variable. Fixed at the source: the spacing plugin now also exports
**`insetClass({pad,x,y,t,r,b,l})`**, the same resolver `<Inset>` uses (same records,
same general→specific order — `<Inset>` now delegates to it). The class strings stay
literal inside the primitive; call sites pass a *step*, never build a class name.

## Verified

Measured on the running app at a 1280px viewport (`getBoundingClientRect` minus each
element's own padding, i.e. true text edges):

| surface | before | after |
|---|---|---|
| page title | 416 | **412** |
| block text | 412 | **412** |
| section list | 352 | **412** |
| title / block-text right edge | 1144 / 1156 | **1156 / 1156** |

- Overriding `--space-md` to 2px moves title *and* block text together (412 → 402),
  proving the density-scaled inset is now shared rather than applied on one side.
- Version-history preview: title row and block text both at 552.
- Blog post: title and block text both at 368; the `border-b` separator at 356,
  bleeding 12px left to `C` as a decoration should.
- Gutter `+` still reveals on row hover (`opacity: 0.6`, `pointer-events: auto`).
- `./equin check` passes, including `layout-geometry` and
  `tailwind-scan-covers-classes`.

## Explicitly out of scope

Two adjacent inconsistencies this analysis surfaced, worth a task but not this change:

- **Decoration bleed disagrees between block types.** The quote's `border-l-2` sits at
  `C`, but the callout's tint and the code background sit at `C + BLOCK_INSET` (their
  `px-md` wrapper is *outside* the decoration). Per the invariant both should bleed to
  `C`. Also, the quote's 2px border pushes its text to `C + 2 + BLOCK_INSET`, so quote
  text is 2px right of every other block's.
- **`read-only-view` re-implements the editor's block chrome by type-name** (`quote`,
  `callout` matched as strings). Sharing the constants narrows the drift but the real
  fix is rendering both from one set of block-handle-driven chrome descriptors.

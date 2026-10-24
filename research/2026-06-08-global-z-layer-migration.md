# Complete the z-layer migration & empty the `no-adhoc-zindex` allowlist

## Context

The semantic z-layer scale (`z-base..z-max`, defined as `@utility` classes in
`plugins/framework/plugins/web-core/web/theme/app.css`) and the
`no-adhoc-zindex` lint rule (`plugins/primitives/plugins/z-layers/lint/`) are in
place, but ~33 files still carry raw Tailwind z-index (`z-0`…`z-50`, `z-[1]`,
`z-[2]`). They are temporarily exempted by the `ignores["no-adhoc-zindex"]`
allowlist in `plugins/primitives/plugins/z-layers/lint/index.ts`.

Goal: migrate every raw z-index in those files to the named semantic layers,
**empty the allowlist**, and have the rule enforce repo-wide with zero
exemptions.

The named ladder is numerically identical to the raw values already used
(`10→z-raised, 20→z-nav, 30→z-float, 40→z-overlay, 50→z-popover`), so the large
majority of sites are a **pure label swap with byte-identical numeric output**
(zero behavioral change). The only interesting work is the handful of
**nested-sticky clusters** that encode a local stacking order with small raw
values (`z-10/z-[2]/z-[1]`, etc.).

### Decision: nested clusters use **isolate + collapse** (Option 2)

For each cluster that orders several sticky/floating peers within one scroll
container, we **add `isolate`** to that container (making the locality real — its
inner z-values become a sealed stacking context that can't leak), then
**collapse to the fewest honest named layers**: any element that only needs to
beat *static* content gets its z **removed** (a `sticky`/positioned element
always paints above static siblings regardless of z); an element that must beat
a *positioned* sibling keeps one real rung. This yields honest labels (nothing
gets called `z-float` that isn't floating) and fewer total z-values, at the cost
of real CSS changes that must be **verified visually per cluster**.

---

## Part A — Clean 1:1 renames (pure label swap, no behavior change)

Numeric value is unchanged; only the class name changes. Low risk.

| File | Site | Change |
|---|---|---|
| `plugins/debug/plugins/profiling/plugins/push/plugins/push-gantt/web/components/push-gantt.tsx` | :151 | `z-10` → `z-raised` |
| `plugins/apps/web/components/app-rail.tsx` | :17 | `z-20` → `z-nav` |
| `plugins/layouts/plugins/miller/web/components/pane-overlay-host.tsx` | :39 | `z-40` → `z-overlay`; update the `z-50` mention in the :22 comment to `z-popover` |
| `plugins/layouts/plugins/miller/web/components/resize-handle.tsx` | :48 | `z-10` → `z-raised` |
| `plugins/code-explorer/web/components/file-tree.tsx` | :142 | `z-10` → `z-raised` |
| `plugins/primitives/plugins/data-table/web/internal/data-table.tsx` | :43 | `z-10` → `z-raised` |
| `plugins/framework/plugins/web-core/web/components/ui/select.tsx` | :79,:84 | `z-50` → `z-popover`; :158,:177 `z-10` → `z-raised` |
| `plugins/framework/plugins/web-core/web/components/ui/dropdown-menu.tsx` | :34,:42 | `z-50` → `z-popover` |
| `plugins/framework/plugins/web-core/web/components/ui/sheet.tsx` | :29,:54 | `z-50` → `z-popover` |
| `plugins/framework/plugins/web-core/web/components/ui/popover.tsx` | :28,:37 | `z-50` → `z-popover` |
| `plugins/framework/plugins/web-core/web/components/ui/dialog.tsx` | :26,:45 | `z-50` → `z-popover` |
| `plugins/framework/plugins/web-core/web/components/ui/tooltip.tsx` | :48,:53,:59 | `z-50` → `z-popover`; also the inner variant token `**:data-[slot=kbd]:z-50` → `**:data-[slot=kbd]:z-popover` |
| `plugins/framework/plugins/web-core/web/components/ui/resizable.tsx` | :42 | `z-10` → `z-raised` |
| `plugins/primitives/plugins/multi-select/web/internal/selection-bar.tsx` | :17 | `z-30` → `z-float` |
| `plugins/apps/plugins/sonata/plugins/piano-keyboard/web/components/piano-keyboard.tsx` | :159 | `z-10` → `z-raised` |
| `plugins/apps/plugins/sonata/plugins/rich/plugins/chord-overlay/web/components/chord-overlay.tsx` | :30 | `z-30` → `z-float` |
| `plugins/page/plugins/editor/web/components/block-row.tsx` | :72,:91,:115,:146 | `z-10` → `z-raised` |
| `plugins/page/plugins/editor/web/components/block-editor.tsx` | :626 | `z-0` → `z-base` |
| `plugins/page/plugins/code-block/web/components/code-block.tsx` | :149 | `z-10` → `z-raised` |
| `plugins/reorder/web/internal/dnd-components.tsx` | :47,:117,:185 | `z-10` → `z-raised` |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/event-row.tsx` | :9 | `z-10` → `z-raised` |
| `plugins/primitives/plugins/tree/web/internal/tree-list.tsx` | :286 | `z-10` → `z-raised` |
| `plugins/primitives/plugins/tree/web/internal/row-chrome.tsx` | :46 | `z-10` → `z-raised` |
| `plugins/conversations/plugins/conversations-view/plugins/grouped/web/components/group-gap-zone.tsx` | :21 | `z-10` → `z-raised` |
| `plugins/conversations/plugins/conversation-view/plugins/commits-graph/web/components/commit-diff-view.tsx` | :124 | `z-[1]` → `z-raised` (lone sticky tier) |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/task-tools/web/components/task-progress-overlay.tsx` | :51 | `z-10` → `z-float` (in-pane floating progress card) |

---

## Part B — Nested-sticky clusters (isolate + collapse; verify each visually)

### 1. code-review — `code-review-section.tsx` + `review-file-row.tsx`

Structure (confirmed): `FileList` renders `<ToolbarRow>` as a **sibling** of
`<Body>` (the `overflow-auto` scroller, line 250). Section triggers + file rows
live **inside** `Body`. `overflow-auto` clips but does **not** create a stacking
context.

- `Body` (`code-review-section.tsx:250`): add `isolate` →
  `"min-h-0 flex-1 overflow-auto isolate"`. Seals the section/file z-values.
- `ToolbarRow` (:227): `z-10` → **`z-raised`** (sticky pane header; sibling of
  the now-isolated `Body`, so it never competes with the inner tiers).
- `FileSectionBlock` trigger (:186): `z-[2]` → **`z-raised`** (must beat the file
  rows; lives in the isolated `Body` context, so equal label to ToolbarRow is no
  conflict).
- `ReviewFileRow` button (`review-file-row.tsx:73`): `z-[1]` → **remove the z
  class** (keep `sticky top-0 …`); a sticky header paints over the static diff
  content beneath it without any z, and the section trigger (`z-raised`) sits
  above it.

Net: three raw values (10/2/1) collapse to a single honest layer (`z-raised`) +
one removal, enabled by `isolate` on `Body`.

**Verify:** scroll the review pane through multiple sections with files expanded —
toolbar stays on top, section header tucks under it, file header tucks under the
section header, file header covers its own diff rows.

### 2. queue — `queue-view.tsx`

- Add `isolate` to the queue scroll container (the element wrapping the group
  headers + pinned cluster; confirm during implementation — the `DndContext`
  content wrapper / list root).
- Group header (:79): `z-20` → **`z-nav`** (sidebar section chrome; must stay
  above the pinned row).
- Pinned cluster (:363): `z-10` → **`z-raised`**.
- Drop zones (:604, :673): `z-10` → **`z-raised`** (each lives in its own
  `relative` `<li>` — already local).

**Verify:** scroll the Queue sidebar with a pinned conversation and multiple
status groups — group headers stay above the pinned row and rows; DnD drop
indicators still render.

### 3. jsonl-pane — `jsonl-pane.tsx`

- Add `isolate` to the pane's outer `relative` container (root of the
  transcript pane that holds the sticky user header + the bottom overlay band +
  jump button).
- Collapsed sticky user header (:86): `z-20` → **`z-nav`**; expanded state
  (:85): `z-10` → **`z-raised`**.
- Jump-to-bottom button (:258): `z-20` → **`z-nav`** (above the band).
- Bottom token-count overlay band (:243): `z-10` → **`z-raised`**.

**Verify:** scroll a long transcript — the sticky user-message header pins and
covers content; expanding it behaves; the jump-to-bottom button sits above the
token band.

### 4. piano-roll — `piano-roll.tsx`

No `isolate` needed — `ScrollLayer` already creates a stacking context via
`transform`, so the note z is trapped; the playhead is a sibling of `ScrollLayer`
and only needs to beat the `z-auto` layer.

- Note rect (:323): `z-10` → **`z-raised`** (local inside `ScrollLayer`).
- Playhead (:427): `z-20` → **`z-raised`** (beats `ScrollLayer`'s `z-auto`;
  different stacking context from the note, so equal label is fine).

**Verify:** the red playhead line renders above the notes and grid while playing.

### 5. sidebar — `plugins/framework/plugins/web-core/web/components/ui/sidebar.tsx`

These are `fixed`/`absolute` shadcn internals; do **not** add `isolate` here
(it would change the containing block for the fixed elements). Pure rename, but
preserve the rail-above-container relation.

- Sidebar container (:233): `z-10` → **`z-nav`** (canonical sidebar layer).
- Sidebar resize rail (:292): `z-20` → **`z-nav`** *if* `SidebarRail` is rendered
  after the container (later DOM sibling wins at equal z — confirm). If the rail
  becomes un-grabbable, fall back to **`z-float`** for the rail.

**Verify:** the sidebar drag-to-resize rail is still hoverable/grabbable on the
sidebar edge.

---

## Part C — Empty the allowlist & update docs

1. `plugins/primitives/plugins/z-layers/lint/index.ts`: **remove the entire
   `ignores` block** (the eslint config tolerates its absence — `c.ignores ?? {}`)
   and rewrite the file header comment to drop the "TEMPORARY allowlist"
   paragraph, stating the rule now enforces with zero exemptions.
2. `plugins/primitives/plugins/z-layers/CLAUDE.md`: delete the final paragraph
   describing the temporary `ignores` allowlist.

Out of scope: `plugins/primitives/plugins/collapsible-wrap/web/internal/collapsible-wrap.tsx:168`
uses `-z-10` (a **negative** z); the rule's regex (`^z-(\d|\[)`) intentionally
does not match negatives, it is not in the allowlist, and the scale has no
"behind-flow" layer. Leave it; mention in the wrap-up.

---

## Verification

1. `./equin check eslint` — must pass with the allowlist emptied (this is
   the definitive proof: every raw z-index is gone, since the rule now applies to
   all 33 formerly-exempt files). Also run full `./equin check` so the
   `plugins-doc-in-sync` check validates the CLAUDE.md edit.
2. `./equin build` — deploys; confirm the app boots at
   `http://att-1780939377-5n5s.localhost:9000` and watch for Tailwind warnings
   about the `**:data-[slot=kbd]:z-popover` variant (confirm the custom
   `@utility` is generated in variant form; the tooltip kbd badge should still
   layer correctly).
3. Screenshot-verify the Part B clusters + a couple of portaled popovers via
   `bun e2e/screenshot.mjs` / Playwright:
   - **code-review pane** (sticky toolbar/section/file ordering)
   - **queue sidebar** (group/pinned ordering, DnD)
   - **jsonl transcript** (sticky user header + jump button)
   - **sidebar resize rail** grabbable
   - **piano roll** playhead over notes
   - one **dropdown/select/dialog/tooltip** popover renders above page chrome

## Caveats to surface in the wrap-up

- The `plugins/framework/plugins/web-core/web/components/ui/*` files are
  shadcn/base-ui components marked "generated, do not edit manually." We edit
  them in place (they are already hand-customized in this repo). A future
  `shadcn add`/regeneration could reintroduce raw `z-50` and trip the rule —
  worth a follow-up (e.g. a post-add codemod or documented step) rather than a
  per-file memory.
- `-z-10` in `collapsible-wrap` (negative z) is left as-is — see Part C.

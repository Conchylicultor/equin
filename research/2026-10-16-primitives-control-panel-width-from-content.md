# Control-panel width derived from content

## Context

The Fold rows page (view settings → Fold rows) opened the filter builder inside
a menu-width popover, and its rule rows overflowed the panel. The quick fix
(b369bec11c) made `PanelStackEntry.size` required. That only forces the code
that opens a page to make a choice, and the choice can still be wrong:
`size: "inherit"` on the Fold page would type-check and still overflow.

The root cause is that the width is declared at the wrong place. It is stated
where a page is opened (`ControlPanelPopover size`, `PanelStackEntry.size`,
`DataViewSlots.Control.size`, the container `panel` prop). Only the content
knows what it needs.

Target model (agreed with the user): **elements declare the width bucket they
need, the surface collects those needs, and the theme sizes the bucket.** On
top of that, a measured overflow check reports any panel whose content still
does not fit, so a missing declaration is caught the first time the panel opens
rather than from a user's screenshot.

## Design

### 1. Content declares its need: `data-cp-needs`

A content element carries `data-cp-needs="described" | "picker" | "builder"`.
`menu` is the baseline and is never declared.

- **Automatic, from vocabulary members:**
  - `ControlPanel.RuleRow` stamps `builder` on its root `<div>`
    (`control-panel/web/internal/rule-row.tsx`).
  - `ControlPanel.Row` with a visible `description` stamps `described`
    (`control-panel-row.tsx`, on the described layout branch).
- **Declared, for content the vocabulary cannot see:** a new optional
  `needs?: Exclude<ControlPanelSize, "menu">` prop on `ControlPanel.Section`
  (and on `Block`, the "control wider than a row" member), stamped on the
  band's element. Examples are a foreign grid such as `IconPicker`,
  `EmojiPicker`, a swatch `Grid` or a `Calendar`. The author writes it next to
  the grid it is justified by, never at the opening row.

### 2. The surface collects: CSS `:has()` on the popup, rank-ordered

- `ControlPanelPopover` stamps `data-cp-surface` on its `PopoverContent`
  popup. It passes `width="content"`, so there is no width utility class to
  fight.
- `ControlPanelStack` stamps `data-cp-showing` on the showing level's
  `[data-cp-level]` div. Hidden levels are `display: none` and must not
  count.
- In `ui-kit/web/theme/app.css`, next to the `cp-*` utilities, rules in
  **rank order** (`menu < described < picker < builder`, same specificity, so
  source order makes the highest-ranked need present win):

  ```css
  [data-cp-surface] { width: var(--popover-width-menu-max); max-width: var(--available-width); }
  [data-cp-surface]:has([data-cp-showing] [data-cp-needs="described"]) { width: var(--popover-width-described); }
  [data-cp-surface]:has([data-cp-showing] [data-cp-needs="picker"])    { width: var(--popover-width-picker); }
  [data-cp-surface]:has([data-cp-showing] [data-cp-needs="builder"])   { width: var(--popover-width-builder); }
  ```

  Rank, not `max()` of pixels. `described` is a wrap width, not a minimum: the
  Pages theme sets menu 248 / described 300, while the default theme sets menu
  300 / described 280. The bucket must be the one the content asked for, sized
  by the theme. This is compliant with `css:no-unanchored-has`: the `:has()`
  compound is anchored by an attribute, and nothing follows it.
- Pure CSS, so the width is right in the same frame the page shows. There is
  no registration state, no extra render and no flash of the wrong width.
  `ControlPanelPane` and dialogs carry no `data-cp-surface`, so they are
  unaffected, as today.

### 3. Remove the opener-side width declarations (one source of truth)

These become redundant or wrong-by-construction, so they are deleted, not kept
as optional floors:

- `PanelStackEntry.size` and `showingSize()`. This reverts the required
  `size`/`"inherit"` from b369bec11c across the ~19 push sites.
- `ControlPanelPopover size`.
- `DataViewSlots.Control.size` (`data-view/web/slots.ts`, `index.ts`,
  `compact-controls.tsx`, `control-trigger.tsx`).
- The container `panel` prop (`page/container/.../appearance-popover.tsx`,
  `container-anchor.tsx`, `container-corner-label.tsx`, `callout-anchor.tsx`).
- `block-actions-menu.tsx`'s conditional `ContainerMenu ? "picker" : "menu"`.
  This is now derived, because the contributed appearance section declares
  `picker`.

Migration so that **today's widths stay identical** (invariant #5, "the
panel does not jump between pages", is preserved by declaring on the page's
content):

| Today | Becomes |
|---|---|
| Filter / Sort controls `size: "builder"`, Fold rows `size: "builder"` | Rows stamp automatically. The empty states (field-search list) and builder sub-pages that hold no rule rows (Add filter, Add sort, Save as preset) declare `needs="builder"` on their `Section`, so the builder never narrows. |
| `size="picker"` popovers (icon-renderer, avatar-picker, date-filter, page-icon-button, change-cover, tag-color, tag-icon, transpose, quick-theme) | `needs="picker"` on the `Section` holding the grid. For quick-theme it goes on the contributed sections that hold the grid (theme-toggle / theme-gallery). |
| `size="described"`: page-kind-control, add-place | Automatic (`Row description`). |
| `size="described"`: loop-toggle, groove-preset-picker | Check the content. Where no visible description exists, keep today's width with `needs="described"` on the section and flag it as possibly mislabelled. |
| callout `panel="picker"` | `needs="picker"` on `CalloutAppearanceFor`'s icon section. |

Raw `PopoverContent width=` users that are not control panels (app-launcher,
artifacts-button, options-pill, the menu-sheet `DropdownMenuContent`) are
untouched.

### 4. Measured overflow check → Reports funnel

This follows the precedent of `viewport-overlay` and `adaptive-bar`.

- `control-panel/web/internal/overflow-guard.ts` defines `useOverflowGuard(ref)`,
  mounted by `ControlPanelPopover` on the `ControlPanel` element. It runs a
  `ResizeObserver` (panel box) plus a `MutationObserver` (subtree, coalesced to
  one check per frame). Both are push-based, with no polling.
- A **fault** is `panel.scrollWidth > panel.clientWidth + 0.5` **while the
  surface is not capped by the viewport** (its width is below
  `--available-width`). A phone-narrow viewport squeezing a builder is not a
  declaration bug.
- `failLoudly`: emit to a `panelOverflowReportSink` (`defineReportSink`),
  carrying the panel label, the showing page title, the needs found, the
  measured and available widths, and a selector path of the widest offender.
  It also throws in `import.meta.env.DEV`. At most one report per panel per
  open.
- New report kind plugin `plugins/reports/plugins/panel-overflow`, a copy of
  the `reports/plugins/viewport-escape` layout (core kind, server task, web
  collector mounted via `Core.Root`, kind view). It drains the sink into
  `report({ kind: "panel-overflow" })`, with the fingerprint built from the
  label and the page title.

### 5. Docs

- Rewrite control-panel `CLAUDE.md` invariant #5 and "The width is the SHOWING
  page's role" to cover: content declares, the surface collects by rank, the
  theme sizes, and the overflow report backs it up. Record why the opener-side
  `size` was removed.
- Update `data-view/CLAUDE.md` (Control `size` example) and the `size.ts` doc
  comment.

## Critical files

- `plugins/primitives/plugins/css/plugins/control-panel/web/internal/`:
  `control-panel-popover.tsx`, `panel-stack.tsx`, `stack-context.ts`,
  `size.ts`, `rule-row.tsx`, `control-panel-row.tsx`, `control-panel.tsx`
  (Section), `block.tsx`, plus the new `overflow-guard.ts`
- `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css` (the rank
  rules)
- `plugins/primitives/plugins/data-view/web/{slots.ts,index.ts}`,
  `components/toolbar/{compact-controls,control-trigger}.tsx`,
  `components/settings/fold-control.tsx`, `components/filter/*`,
  `components/sort/*`
- The picker and described call sites listed in the table
- New: `plugins/reports/plugins/panel-overflow/`

## Verification

1. `./singularity build` (the type check catches every removed `size` use; the
   `css:no-unanchored-has` and `plugins-doc-in-sync` checks run too).
2. `./singularity test plugins/primitives/plugins/css/plugins/control-panel
   plugins/primitives/plugins/data-view`. The jsdom tests assert the stamps:
   `RuleRow` and `Row description` carry `data-cp-needs`, only the showing
   level carries `data-cp-showing`, and the popup carries `data-cp-surface`.
   Replace the two popover width-class tests with stamp tests.
3. Real-browser check with `screenshot.ts` against this worktree's deploy:
   - view settings → Fold rows, with a date rule: the panel is builder-width
     and nothing overflows (the original bug)
   - the toolbar Filter popover, empty and with rules: the same width, with no
     jump on the first rule
   - a nested filter group and Add filter: they stay builder-width
   - a picker (page icon button) and a described menu (page kind): widths
     unchanged
   - measure the popup width with `getBoundingClientRect` against the tokens
4. Falsify the guard: temporarily drop `needs="builder"` from the empty filter
   state, or render a rule row in a menu-only panel, in a scratch exhibit, and
   confirm a `panel-overflow` report appears in Reports. Revert afterwards.
5. `./singularity check layout-geometry`: the control-panel exhibits still
   pass.

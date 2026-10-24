# Menu prototype parity, round 2: model picker, one width rule, Mist overlay surface

## Context

Every menu row now draws through `MENU_ROW*` (`ui-kit/web/theme/menu-row.ts`) plus the
`menu-row` / `menu-row-lit` utilities (`ui-kit/web/theme/app.css`). Menus still do not
match the Menu prototype `proto-1791412353-x9vk` (mock of `exhibit:ui-kit/menu-sheet@/agents`):

1. The launch model picker (`LaunchModelMenuContent`) hand-rolls its row: a `min-w-[15rem]`
   width, `gap-lg`, a made-up check, a full-size `IconButton` that makes rows taller, and a
   `Kbd` keycap. The shared row has no slot for a selected default, a shortcut beside a check,
   or a per-row action, so the call site rebuilt them.
2. Menus are too narrow. The `menu-min` floor is 11rem; the mock uses `max-content`, min 200px,
   max 300px.
3. Widths differ from menu to menu. Dropdowns size to content (`menu-min`), control-panel popovers
   use a fixed `menu` width of 262px, and Selects match their trigger exactly (`anchor`).
4. Colours. The mock's panel is `bg-2` (0.265), its hover `bg-3` (0.305) and its border `--line`.
   Mist sets `popover = card = panel` (0.225), and an overlay's hover goes through
   `--hover-fill → --selected → --accent = fill` (0.265). So in the app a menu is darker than
   designed and has no contrast against a card behind it.
5. Guardrail. `focus-border` / `focus-border-within` (app.css:250/257) read
   `var(--color-input)` / `var(--color-foreground)`. Those are `@theme inline` bridge copies
   computed at `:root`, so scoped themes are ignored. Nothing stops this from happening again.

Rules: geometry is global; colours come from Mist's own constants; no hardcoded or duplicated
values.

## 1. Model picker: three new capabilities in the shared row

`ui-kit/web/components/ui/dropdown-menu.tsx`. Every item that owns a row (`Item`,
`CheckboxItem`, `RadioItem`) gets one shared trailing cluster, in this order:

`label (1fr) | action | shortcut | check`

- **`shortcut?: string`**: rendered with `MENU_VALUE` (the `DropdownMenuShortcut` style, plain
  faint caption text). Never a keycap.
- **`action?: { icon: IconRef; label: string; onAction: (e) => void }`**: a hover action on the
  row. ui-kit renders it itself, so its size cannot be wrong: a ghost `Button size="icon-xs"`
  (`control-icon-xs` ≤ `--panel-row-h`, so the row keeps its height) with `aria-label` and
  `title`.
  - It is hidden at rest and shown on `group-data-highlighted/…` (pointer and keyboard
    highlight both, not just `:hover`).
  - `stopPropagation` runs on pointerdown and click, so the row's own select does not fire.
  - ui-kit sits below `icon-button`, so the `prefer-icon-button` lint gets an inline disable
    with that reason.
- The **check** stays in the existing indicator cell (`RadioItem` / `CheckboxItem`).
- The grid becomes `grid-cols-[minmax(0,1fr)_auto_auto_auto]`, with empty cells collapsing
  (`empty:hidden`). `DropdownMenuItem` gets the same cluster without the check cell.
- `MENU_ROW`'s `gap-sm` stays the only gap.
- Add one class list `MENU_ROW_TRAIL` to `menu-row.ts` (`ml-auto flex items-center gap-xs`).
  `SubTrigger`'s chevron and `DropdownMenuShortcut` reuse it.

**`LaunchModelMenuContent`** (`plugins/primitives/plugins/launch/web/components/launch-control.tsx:126`)
becomes plain composition:

- `DropdownMenuRadioGroup value={defaultModel} onValueChange={setDefaultModel}` (base-ui's
  `RadioItem` takes `closeOnClick` to keep today's click-closes behaviour).
- Each model is
  `<DropdownMenuRadioItem value={id} shortcut={formatShortcutLabel(\`mod+${i+1}\`)} action={{ icon: playArrowIcon, label: \`Launch ${choiceLabel(id)}\`, onAction: (e) => launch(id, e) }}>`.
- Delete the `className` overrides, the `Stack`s, `checkIcon`, the `Kbd` import and its
  eslint-disable. The `mod+N` `onKeyDown` stays.

Add a generic specimen to `ui-kit/exhibits/internal/menu-sheet.tsx`: a radio group with
shortcut + action, so the new row is covered in the catalog.

## 2 + 3. One width rule for every menu

One rule: **a menu is as wide as its items, clamped between two density tokens.** A theme that
wants a fixed width sets both tokens to the same value.

- `plugins/ui/plugins/tokens/plugins/density/core/group.ts`:
  - `popoverWidthMenuMin` changes from 11rem to **12.5rem** (200px, the mock).
  - `popoverWidthMenu` (a fixed 16.375rem) is renamed **`popoverWidthMenuMax`**, default
    **18.75rem** (300px, the mock).
  - `popoverWidthDescribed` default changes to **17.5rem** (the mock's 280px described menu).
- `ui-kit/web/theme/popover-width.ts`:
  - `menu-min` merges into **`menu`**:
    `w-max min-w-[min(var(--popover-width-menu-min),var(--available-width,100vw))] max-w-[min(var(--popover-width-menu-max),var(--available-width,100vw))]`.
  - Drop the `menu-min` member; tsc finds every user. Update the comment block, including the
    stale "262px …" line.
- Split by kind (decided with the user, following the common practice: a menu is sized to its
  content between a min and a max, and a surface never resizes while it is open):
  - **Plain menus** (`DropdownMenuContent` / `SubContent`, Select) read the content-sized `menu`
    role. Default `width="menu"`.
  - **Control panels** (multi-page, so they must not jump between pages) keep one FIXED width per
    kind. `ControlPanelPopover size="menu"` maps to a new fixed role **`panel`**:
    `w-(--popover-width-menu-max)`. A choice panel is then exactly as wide as the widest plain
    menu: the same token, not a separate 262px. `builder`, `picker` and `described` keep their
    fixed tokens.
  - **`SelectContent`**: default changes from `anchor` (exact trigger width, floor 9rem) to
    **`anchor-min`**, re-floored as `max(var(--popover-width-menu-min), var(--anchor-width,0px))`
    with the same max. A listbox is then at least its trigger and at least a menu. Its left edge
    still lines up with the value.
- Long labels already truncate (`min-w-0 truncate` label cell), so the max cap is safe.
- Pages theme (`plugins/apps/plugins/pages/plugins/shell/web/internal/theme.ts:122`): today
  `popoverWidthMenu: 15.5rem` sets its section panel's fixed width. It is renamed to
  `popoverWidthMenuMax`, so Pages panels stay 15.5rem and Pages' plain menus are capped there.

## 4. Colours: a popover surface one step up in Mist

The overlay surface gets its own hover token, the same way `sidebar` has `sidebarAccent`.
Repointing Mist's `selected` instead would also brighten every selected list or tree row on a
base surface, which the Mist design keeps at `bg-2`.

- `plugins/ui/plugins/tokens/plugins/color-palette/core/group.ts`: add
  **`popoverHover`** ("Popover row hover"), default `var(--selected)`, so no theme changes until
  it opts in.
- `ui-kit/web/theme/surface.ts:62` (`overlay`): change `[--hover-fill:var(--selected)]` to
  `[--hover-fill:var(--popover-hover)]`. Add the `--color-popover-hover` bridge in app.css only
  if a class needs it (none does).
- `mistTheme` (`plugins/apps/plugins/agent-manager/plugins/shell/web/internal/theme.ts`), dark,
  reusing its existing constants:
  - `popover = fill` (0.265)
  - `popoverHover = fillHover` (0.305)
  - `popoverBorder = input` (the mock's `--line`, 0.35 / .7)
- Light Mist: set the same three by role (`popover` stays white, `popoverHover = fill`,
  `popoverBorder = input`), so light keeps the "step up" relationship. Nothing else changes.
- Side effect to check: every Mist overlay (popovers, selects, dialogs that use `bg-popover`)
  goes up one step. That is the intent, since an overlay floats above cards.

## 5. Guardrail: no reads of `@theme` bridge copies outside `@theme`

- Fix app.css:250/257: `color-mix(in oklch, var(--input), var(--foreground) 18%)`.
- New check `theme-bridge-reads`
  (`plugins/framework/plugins/tooling/plugins/checks/plugins/theme-bridge-reads/check/index.ts`,
  modelled on its sibling `inherited-theme-defaults-scoped`):
  - Collect every `--color-*` declared in an `@theme inline` block.
  - Reject `var(--color-X)` for any of them anywhere else: in plugin `.css` outside `@theme`, and
    in `.ts`/`.tsx` string literals (arbitrary values such as `bg-[var(--color-x)]`,
    `[--y:var(--color-x)]`).
  - The message names the runtime var to read instead (`var(--x)`) and gives the reason (a
    bridge is computed at `:root`, so a scoped theme is ignored).
- Document it in `ui-kit/web/theme/CLAUDE.md` next to the bridge description. Add a pointer in
  the `## Menu rows share one definition` section of `ui-kit/CLAUDE.md`, and document the new
  slots (`shortcut`, `action`) and the one width rule there.

## Files

- `ui-kit/web/components/ui/dropdown-menu.tsx`, `select.tsx`, `web/theme/menu-row.ts`,
  `popover-width.ts`, `surface.ts`, `app.css`, `exhibits/internal/menu-sheet.tsx`, `CLAUDE.md`,
  `web/theme/CLAUDE.md`
- `plugins/primitives/plugins/launch/web/components/launch-control.tsx`
- `plugins/ui/plugins/tokens/plugins/density/core/group.ts`, `color-palette/core/group.ts`
- `plugins/apps/plugins/agent-manager/plugins/shell/web/internal/theme.ts`,
  `plugins/apps/plugins/pages/plugins/shell/web/internal/theme.ts`
- `control-panel` size mapping (no change expected; verify)
- new `checks/plugins/theme-bridge-reads/`

(`ui-kit` is short for `plugins/primitives/plugins/css/plugins/ui-kit`.)

## Verification

1. `./equin build` (runs checks: type-check catches every removed `menu-min` /
   `popoverWidthMenu` use; the new check passes after the app.css fix).
2. Temporarily revert the app.css fix and confirm `./equin check theme-bridge-reads`
   fails with the right message.
3. `./equin run plugins/apps/plugins/prototypes/plugins/compare/e2e/compare-diff.ts --name proto-1791412353-x9vk --width 1440`.
   The diff ratio should drop, and the colour report should show the panel ≈ 0.265 and the
   hover ≈ 0.305.
4. Screenshot the sidebar launch dropdown with
   `e2e-harness/e2e/screenshot.ts --path /agents --click "<model trigger>"`. Check that:
   - rows are the same height as the other menus;
   - the check is in the shared cell;
   - the shortcut is faint text;
   - the play button appears on hover and on arrow-key highlight;
   - clicking a row sets the default and closes the menu;
   - clicking play launches without changing the default.
5. Spot-check a Select, a control-panel popover (Filter/Sort) and the Pages section menu (still
   15.5rem fixed).
6. `./equin test plugins/primitives/plugins/css/plugins/ui-kit` (row/menu tests).

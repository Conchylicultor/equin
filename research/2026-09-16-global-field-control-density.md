# Inputs and selects follow control density

## Context

A density preset now sets a button's height, side padding and icon gap
(`research/2026-09-15-global-button-density-padding.md`). The ui-kit `Input` and
`SelectTrigger` do not follow it:

- Their heights are fixed classes: `h-8`, and `data-[size=sm]:h-7` on the select.
- Their padding and gap come from the layout spacing ramp (`px-sm`, `py-xs`, `gap-xs`).
- They ignore the surrounding control size. The select has its own `size` prop instead.

So "Fill from → Compact" makes the buttons in a form row shorter and narrower,
but leaves the inputs and selects beside them unchanged. The row stops lining up.

The code has already worked around this in many places. Callers copy a size's
height by hand:

- The model, effort and preprompt pickers, and Sonata's rhythm selects, add
  `h-7 text-caption`.
- The table-cell editors add `h-6 px-xs py-none`.
- The data-view filter value input adds `h-(--control-height-sm)`.
- The code-block language select adds `size="sm" h-6`.

**Outcome:** a field is one more control that reads the size it sits in. Its
height, side padding and gap come from the same per-size density tokens as
Button (`control-*`, `px-control-*`, `gap-control-*`). No field has a `size`
prop or a hand-written height.

**Decision (user, 2026-09-16):** fields use Button's padding tokens. No separate
field padding tokens are added. In the Default theme, field text moves 2px
further in on each side (8→10px). Heights do not move, because `h-8` is already
`control-md` and `h-7` is already `control-sm`.

## Design

### 1. A size-to-classes map for fields

Add `fieldSizeClassFor(density)` to `ui-kit/web/theme/control-size.tsx`, next to
`buttonTextClassFor`. It returns one class list per size:

| density | classes |
| --- | --- |
| xs | `control-xs px-control-xs gap-control-xs text-body-compact` |
| sm | `control-sm px-control-sm gap-control-sm text-body` |
| md | `control-md px-control-md gap-control-md text-body` |
| lg | `control-lg px-control-lg gap-control-lg text-body` |

- **Type.** The text rung comes from `textStepFor`, the same step Button,
  Badge and Text use. Fields keep the `body` role (400 weight): typed text is
  content, not a control label. Only `xs` drops a rung.
- **No vertical padding.** The height is fixed and the content is centred, so
  `py-*` is deleted. The cell editors' `py-none` becomes unnecessary.
- **One map for both components.** Keeping it in one place means Input and
  SelectTrigger cannot disagree on a size.

### 2. `Input` (`ui-kit/web/components/ui/input.tsx`)

- Read `useControlSize()`.
- Replace `h-8 px-sm py-xs text-body md:text-body` with `fieldSizeClassFor(density)`.
- Type the props with `DensityControlled`, like Button. This rules out
  `size` as a prop. The native `size` attribute (character width) has no users.
- Keep `file:h-6`, but tie it to the size: `file:h-full`. The file button then
  follows the field's height.

### 3. `SelectTrigger` (`ui-kit/web/components/ui/select.tsx`)

- Delete the `size` prop and `data-size`. Read `useControlSize()`, and type the
  props with `DensityControlled`.
- Replace `data-[size=*]:h-*`, `py-sm pr-sm pl-sm` and `gap-xs` with
  `fieldSizeClassFor(density)`.
- The `sm` corner clamp `rounded-[min(var(--radius-md),10px)]` now keys on the
  size, matching Button: `xs` and `sm` take their clamp; `md` and `lg` stay `rounded-lg`.
- The inner `select-value` `gap-xs` becomes `gap-inherit`, so the icon-to-label
  gap inside the value is also the size's gap.

### 4. Lint: add fields to the density set

In `control-size/lint/no-adhoc-density.ts`, add `Input`, `SelectTrigger`,
`SidebarInput`, `SearchInput` and `FilterValueInput` to `DENSITY_PRIMITIVES`.
The rule then rejects a leftover `size=` prop or `h-N` / `control-*` class on a
field.

In `no-adhoc-density.test.ts`, the valid case `<SelectTrigger size="sm" />`
becomes an invalid case. Add an invalid `<Input className="h-7" />` case.

### 5. Migrate the callers onto ambient size

Delete each hand-copied size and declare the size on the region instead. Prefer
a region primitive (`Bar` is `sm`, `DataTable` is `xs`, `Card controlSize`) or
the slot's `controlSize`. Use `<ControlSizeProvider>` only for bespoke markup.

| caller | today | change |
| --- | --- | --- |
| `fields/{text,number,tags}/inline` editors | `h-6 px-xs py-none` | Drop the classes. `editable-cell.tsx` already provides `xs`, so there is no visual change. |
| `data-view/.../filter-value-input.tsx` | `h-(--control-height-sm)` | Drop it. Wrap the filter-rule row in `sm`, so the field and operator pickers beside it share that size. |
| `data-view/.../chip-select-filter-input.tsx` | `h-6 px-xs py-none` | Drop it. Wrap that popover's search row in `xs`. |
| `model-select` / `effort-select` / `preprompt-select` | `h-7 … text-caption` | Drop `h-7` and `text-caption`. The `TaskLaunch.Option` slot is already `sm`. The launch popover's preprompt picker stays `md`, as today. Keep the `w-*` widths. |
| `sonata/.../track-config.tsx` (2 selects) | `h-7 … text-caption` | Drop them. Wrap the track config stack in `sm`. |
| `page/code-block/.../code-block.tsx` | `size="sm" h-6 text-caption` | Drop them. Wrap the hover toolbar in `xs`. |
| `ui-kit/.../sidebar.tsx` `SidebarInput` | `h-8` | Drop it. The height is ambient, `md` by default. |
| `primitives/search/.../search-input.tsx` | `h-7 text-caption` | Drop them. **19 callers**: those in a `Bar` get `sm` automatically. Audit each of the rest and give its region a size, not the input. |
| `reorder/editor/.../items.tsx` | `h-7 text-caption` | Drop them. Put the reorder editor's search row in `sm`. |

`pl-xl` / `pl-7` / `pr-2xl` leave room for icons inside the field. They are
not size classes, so they stay. A later `pl-*` beats `px-control-*` through the
`extend px` twmerge marker.

The 29 bare `<Input>` uses need no edits. They stay `md` unless their region
declares otherwise.

### 6. Docs

- Theme skill, section "Control size = density inherited from context": add
  `Input` / `SelectTrigger` to the "no control has a `size` prop" list, and
  explain that fields read the same height, padding and gap tokens.
- `ui-kit/CLAUDE.md`, ControlSize paragraph: one sentence on
  `fieldSizeClassFor`.
- `2026-09-15-global-button-density-padding.md` "Out of scope": mark the
  Input/Select follow-up as done and link here.

## Outcome (2026-09-17): heights shared, look kept

The first build used Button's padding and the `body` text everywhere. The
density part worked, but the default theme lost its quieter compact fields:
small pickers and search boxes went from 12px to 14px text, padding from 8px
to 10px, and search boxes from 28px to 32px. Nothing had been visibly broken
in the default theme, so the user chose to keep the fix and **revert the look**
(this supersedes the padding decision above):

- `fieldSizeClassFor` shares only the height (`control-*`). Padding and gap
  are the spacing ramp the fields used before (`px-sm gap-xs`; `px-xs` at
  `xs`), which density presets scale too.
- Text: `caption` at `sm`, `body` elsewhere, including `xs`, where cell editors
  always showed body text.
- `SearchInput` is compact by construction: it declares `sm` itself, as `Bar`
  does.
- The screens that had a hand-written compact field now declare that size
  around the field only: the "Other…" answer input, the reorder editor's
  search, the chip-select filter search (`xs`), the code-block language picker
  (`xs`, keeping its own `px-sm text-caption`) and Sonata's two rhythm selects.
  The copy button and Sonata's steppers keep their size.
- **Kept on purpose:** the filter value input stays at the row's `md`,
  level with the field/operator pickers beside it. It was 28px next to 32px
  before.

## Verification

1. `./equin build` passes, including type-check, eslint with the extended
   `no-adhoc-density`, and `css-vars-supplied`.
2. Tests:
   - `./equin test plugins/primitives/plugins/css/plugins/control-size`
     runs the lint tests.
   - Add a `control-size.test.ts` case for `fieldSizeClassFor`, covering each
     size and the `xs` text step. Run
     `./equin test plugins/primitives/plugins/css/plugins/ui-kit`.
3. **Default theme: heights do not move.** Use `screenshot.ts` before and after
   on four screens: the task launch options (model/effort/preprompt selects), a
   data-view filter popover, a table cell in edit mode, and a settings config
   form. In the browser, check that:
   - A bare Input is 32px tall with 10px `padding-inline`.
   - A launch-option select is 28px.
   - A cell editor is 24px.
4. **The tokens drive fields.** In the customizer's Density section, use "Fill
   from → Compact". An input and select next to a button change height and
   padding together. Edit "Control padding MD": a bare Input's padding follows.
5. **SearchInput callers:** screenshot each of the 19 callers whose size came
   from the removed `h-7`. None should jump to 32px unless its region is
   genuinely `md`.

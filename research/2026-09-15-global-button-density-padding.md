# Buttons read their width from the density tokens

## Context

A theme can set how tall a button is, but not how wide. The density token
group sets the four control heights, and `Button` follows them. But `Button`
writes its side padding and its icon-to-label gap as fixed Tailwind numbers per
size (`px-2.5 gap-1.5` …), so no theme can change them.

This showed up on the equin website. The mock's header button has 18px side
padding. The site's button measured 10px, so the button came out 116px wide
instead of 133px. (See `research/2026-09-10-global-mockup-fidelity-reflection.md`,
§4 and gap #4.)

The density group does have a "Control padding X / Y" pair, but `Button` never
read it. Only two things use it: the medium toggle chip (`p-control`) and
data-table rows (`py-control`).

**What we want:** each control size is one set of values the density group
owns: height, side padding and gap. Button reads all three. There is exactly
one control padding scale, so the customizer no longer shows two
"control padding" concepts that are easy to mix up.

**Decision (user, 2026-09-15):** fold the old pair into the new scale. Toggle
chips move onto the new scale and get 2px narrower per side (12→10px). Data
tables move to the row padding token, which has the same value in every preset.
The old two tokens are deleted. No saved theme in the DB has density or shape
values (checked with `query_db` on `saved_themes`). The only code theme that
sets them is the website's, and deleting the tokens makes it a compile error
there, which forces the update.

## Design

### 1. Tokens — `plugins/ui/plugins/tokens/plugins/density/core/group.ts`

Remove `padControlX` and `padControlY`. Add eight tokens next to the
`controlHeight*` tokens. Their defaults are exactly what `Button` renders today
with the shape group's 0.25rem base spacing, so the Default theme does not move:

| token → CSS var | default | today's class |
| --- | --- | --- |
| `controlPadXs` → `--control-pad-xs` | `0.5rem` | `px-2` |
| `controlPadSm` / `Md` / `Lg` | `0.625rem` | `px-2.5` |
| `controlGapXs` → `--control-gap-xs` | `0.25rem` | `gap-1` |
| `controlGapSm` | `0.25rem` | `gap-1` |
| `controlGapMd` / `Lg` | `0.375rem` | `gap-1.5` |

Labels: "Control padding XS…LG" and "Control gap XS…LG". There is no vertical
padding token. A control's height is fixed and its content is centred, so
vertical padding does nothing to it.

Fill-from shortcuts (`density/web/shortcuts.ts`): Comfortable uses the defaults.
Cozy and Compact step the padding down the same way they already step the
heights: Cozy pads xs 0.4375 / other sizes 0.5625, gaps 0.25 / 0.3125; Compact
pads 0.375 / 0.5, gaps 0.1875 / 0.25. With these, Compact's medium chip keeps
its current 8px.

### 2. Utilities — `ui-kit/web/theme/app.css`

Add two utility families next to `control-*` (heights, around line 453). Each
one has a `twmerge` marker, so `cn()` treats it like the built-in class it
replaces:

```css
@utility px-control-xs { padding-inline: var(--control-pad-xs); } /* twmerge: extend px */
… sm / md / lg
@utility gap-control-xs { gap: var(--control-gap-xs); }          /* twmerge: extend gap */
… sm / md / lg
```

- They use `padding-inline` because that is the property Tailwind v4's `px-*`
  emits. A caller's `pl-*`, `pr-*`, `px-0` or `p-0` override therefore behaves
  exactly as it does against `px-2.5` today.
- They are named classes in `app.css`, not arbitrary values like
  `px-(--control-pad-md)` inside the TSX, so the `css-vars-supplied` check
  catches a misspelled variable name. An arbitrary value in TSX would quietly
  give zero padding.
- They are word-valued, so the `no-adhoc-spacing` lint accepts them. `gap` is
  a ramp family, but extra non-ramp members of a family are allowed (see
  `space-ramp-gen.ts`, the comment above `parseSpaceRamp`).

Delete `p-control` and `py-control`. Add `py-row`, which is the vertical half of
`p-row`:
`@utility py-row { padding-top: var(--pad-row-y); padding-bottom: var(--pad-row-y); } /* twmerge: extend py */`.

### 3. Button — `ui-kit/web/components/ui/button.tsx`

In the `size` variants, swap the numbers for the utilities:

- `xs: "control-xs gap-control-xs px-control-xs rounded-[…] …"`
- `sm` / `md` / `default` / `lg` the same, each with its own size's classes.

Also delete the `has-data-[icon=inline-start|end]:pl-/pr-` icon-side trims.
They come from the shadcn template, and nothing in the repo sets `data-icon`
(checked with `rg`). Leaving them would mean a fixed number sitting next to a
token in the same class list. The icon-shaped sizes and `inline` don't change,
because they have no side padding.

### 4. Fold the old consumers onto the new tokens

- **ToggleChip** (`toggle-chip/web/internal/toggle-chip.tsx`): the medium chip
  changes from `control-sm p-control` to `control-sm px-control-sm gap-control-sm`.
  It already matches the height of the small button beside it. Now it matches
  that button's width rhythm too. Badge's `region-line` centres the content, so
  the vertical padding the chip loses changes nothing.
- **DataTable** (`data-table/web/internal/data-table.tsx`, 2 sites): change
  `py-control` to `py-row`. The value is identical in every preset and in the
  website theme.
- **Lint text that names `p-control` as an allowed padding class**: update the
  lists and messages in `badge/lint/no-adhoc-chip.ts`, `badge/lint/index.ts`,
  `row/lint/no-adhoc-row.ts` and `row/lint/index.ts`, plus the comment in
  `codegen/core/space-ramp-gen.ts`.
- **Tests** in `ui-kit/web/lib/utils.test.ts`: change the `py-control` case to
  `py-row`. Add a case where `px-control-md` loses to a later `px-0`, and one
  where `gap-control-md` loses to a later `gap-xs`.

### 5. Website theme — `apps/website/plugins/shell/web/internal/theme.ts`

Remove `padControlX` / `padControlY` from the density fragment. Set
`controlPadSm: "1.125rem"`, the mock's 18px on the header's call-to-action pill.
Leave the medium size, used by the contact-card buttons, at the default unless
a measurement shows the mock differs.

**Side effect to check, not to hide:** the header's quiet nav links are ghost
buttons at the same small size, so they widen to 18px too. On them the padding
is invisible and only shows as extra space between nav words. After building,
compare the header against the mock (next section). If the nav words then sit
further apart than in the mock, the mismatch is about the pill shape, not about
density. A pill's rounded ends need extra side room that a rectangle does not.
In that case report "pill padding" as the next missing rung. Do not work around
it with a `px-*` class on one button.

### 6. Docs

- Theme skill (`.claude/skills/theme/SKILL.md`), in the "Control size = density
  inherited from context" section: say that the size set's height, padding and
  gap are all density tokens (`controlHeight*`, `controlPad*`, `controlGap*`),
  so a theme owns a control's full size.
- `ui-kit/CLAUDE.md`, ControlSize paragraph: one sentence saying the same.
- Reflection doc, gap #4: add one line saying it is fixed, with a link here.

`./equin build` regenerates the generated files:
`token-group-vars.generated.ts` and `custom-utilities.generated.ts`.

## Out of scope (follow-ups to file)

- `Input` and `SelectTrigger` also hardcode their size metrics. Their heights
  are `h-8` / `h-7`, not `control-*`, and their padding comes from the spacing
  ramp. They should read the same per-size tokens. That is a separate change,
  because their vertical metrics would move too. *Done: see
  `2026-09-16-global-field-control-density.md`.*
- Extra padding for pill-shaped buttons, if the header check in §5 shows it is
  needed. *Done: the shape group's `pillPadExtra` — see
  `2026-09-15-global-pill-button-padding.md`.*

## Outcome (2026-09-15)

- **Default theme:** 204 controls on `/agents` were matched against main.
  Buttons measure the same. The only metric change is the three toggle chips,
  whose side padding went from 12px to 10px, as agreed.
- **Website:** the Improve pill has 18px padding and 38.4px height, and it
  matches the mock's width to within 1px (108px in the mock, 109px here).
- **The side effect happened.** The quiet nav links now sit about 42px apart,
  against the mock's ~29px (it was ~24px before this change). So at the same
  size the mock uses about 12px for ghost links and 18px for the pill. That is
  a question about the pill shape, filed as its own task. The Input/Select
  follow-up is filed too.

## Verification

1. `./equin build` passes, including `css-vars-supplied`,
   `app-css-utilities-in-sync`, `token-group-vars-in-sync`, type-check and
   eslint.
2. `./equin test plugins/primitives/plugins/css/plugins/ui-kit` runs the
   new `cn()` cases.
3. **Default theme does not move.** Take `screenshot.ts` captures of a toolbar
   with text buttons (the agent-manager conversation view) before and after.
   In the browser, a medium button's computed `padding-inline` is still 10px
   and its gap is still 6px. A SegmentedControl (such as a data-view view
   switcher) is 2px narrower per chip side, as agreed.
4. **Tokens drive width.** In the customizer's Density section, use "Fill
   from → Compact": text buttons get narrower as well as shorter. Edit
   "Control padding MD" and a medium button's width follows.
5. **Website.** Extend `apps/website/plugins/shell/e2e/site-chrome-verify.ts`
   so it checks that the header pill's computed `padding-inline-start` is 18px
   and its width is about 133px. Then run
   `compare-diff.ts --name proto-1788797350-gqju` at 1280 wide and look at the
   header cells of the heatmap: the pill should now line up, and check the nav
   words against §5.

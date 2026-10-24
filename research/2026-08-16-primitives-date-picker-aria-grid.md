# The date-picker calendar becomes a real ARIA grid

## Context

`plugins/primitives/plugins/date-picker/web/components/calendar.tsx` paints a
month as one flat 7-column CSS grid holding 42 `<Button>`s. It used to also
declare `role="grid"` — a promise of `role="row"` children that did not exist,
so assistive tech announced an empty grid and dropped the day buttons behind it.
The `aria-safety/no-orphan-composite-role` lint rule caught that, and the role
was removed. Strictly better, but it left the calendar with no structure at all:

- **No weeks.** A screen-reader user hears 42 buttons in a row, with nothing
  saying where one week ends and the next begins.
- **No column headers.** The `Mon Tue Wed…` strip is decorative text that is not
  associated with any cell, so "which weekday is this?" is unanswerable without
  reading the number's own label — and the day buttons' only label today is the
  bare number (`"6"`), so it isn't answerable at all.
- **No keyboard navigation.** Arrow keys do nothing. The only way to move
  between days is Tab, which means **42 tab stops** to cross one month, and the
  month pager is unreachable from the middle of the grid without tabbing out.
- **Selection is a toggle button.** `aria-pressed` on each day says "pressed",
  not "selected", and today is a visual ring with no announced counterpart.

A date picker is the textbook case where the ARIA grid pattern actually fits, so
the fix is to give the calendar real rows rather than to keep dropping the
semantics. This is the mirror image of the decision recorded in
[`2026-08-15-page-block-list-accessible-selection.md`](./2026-08-15-page-block-list-accessible-selection.md):
there, the rows were `contenteditable` prose that could not carry `aria-selected`,
so the composite role was dropped and state moved to `announce()`. Here the cells
are plain non-editable buttons that *can* carry the real semantics, so the
composite role is the honest answer.

Outcome: one tab stop into the calendar, arrow keys that walk the month (and page
across month boundaries), weekday column headers bound to their cells, and each
day announced by its full date with its selected / today state.

## Design

### Structure — nested per-week grids, not `display: contents`

```
Stack   role="grid"  aria-labelledby={titleId}  onKeyDown            ← the grid
├─ Grid cols={7}  role="row"                                         ← header row
│  └─ Center ×7   role="columnheader"  aria-label="Monday"           ← weekday
└─ Grid cols={7}  role="row"  ×6                                     ← week rows
   └─ Center ×7   role="gridcell"  aria-selected={selected}
      └─ Button   aria-label="Friday, August 21, 2026"  tabIndex=0|-1
```

Each week is its **own** `<Grid cols={7} gap="none">`. Columns still line up
across weeks because every row has identical `repeat(7, minmax(0,1fr))` tracks in
a container of identical width. The alternative — keeping one flat grid and
giving the `role="row"` wrappers `display: contents` — is rejected: several
screen readers still drop roles on `display:contents` elements, which would
reintroduce exactly the bug this change exists to fix.

`role="gridcell"` goes on the existing `<Center>` box (which already does the
centering work), **not** on the `<Button>`. A generic `<div>` between `row` and
`gridcell` would break the owned-element relationship, and overriding the
button's own role would cost the native "button" announcement. A gridcell whose
content is a widget is the standard APG shape; focus lives on the button.

`aria-selected` sits on the cell (the grid's own selection carrier) and replaces
today's `aria-pressed` on the button — a day is a selected cell, not a pressed
toggle. Today gets `aria-current="date"` on the button, so the visual ring
finally has an announced counterpart.

The lint rule is file-scoped (a `role="grid"` needs a literal `role="row"`
somewhere in the same file), so this structure satisfies it with no escape hatch.

### Keyboard model (WAI-ARIA APG date grid)

One handler on the grid container, so it works wherever focus is:

| Key | Effect |
| --- | --- |
| `←` / `→` | ∓1 day |
| `↑` / `↓` | ∓7 days |
| `Home` / `End` | first / last day of the focused week (`weekStartsOn`-aligned) |
| `PageUp` / `PageDown` | ∓1 month |
| `Shift+PageUp` / `Shift+PageDown` | ∓1 year |
| `Enter` / `Space` | native `<button>` activation — no custom handling |

Crossing a month boundary pages the view and keeps focus on the day you moved to.
Movement onto a day outside `min`/`max` is refused (focus stays put) — the bounds
are a contiguous range, so there are never holes to jump over, and this is the
natural "slider hits its end" behaviour.

### Roving tabindex

Exactly one day button carries `tabIndex=0`; the rest are `-1`. The roving target
is **derived**, never allowed to drift out of the rendered month:

```
activeDay = isSameMonth(focusedDay, viewMonth) ? focusedDay : pickFocusDay(…)
```

`pickFocusDay` prefers the selected day, then today, then the 1st — taking the
first candidate that is inside the view month **and not disabled**, falling back
to the first enabled day in the grid. That last clause matters: if `min` starts
mid-month and the 1st is disabled, a `tabIndex=0` on a `disabled` button would
drop the whole calendar out of the tab order.

Because keyboard navigation always sets the focused day and the view month
together, the derived rule holds with no synchronising effect.

DOM focus is moved imperatively after the state commit: the handler records the
target's ISO day in a ref, and a layout effect focuses
`[data-day="<iso>"]` inside the grid and clears the ref. Keying off a `data-day`
attribute (rather than a ref map) keeps it a single lookup that survives the
whole grid re-rendering when the month pages.

### Announcements

`announce(monthTitle(next, locale))` fires from `goToMonth` — the calendar's own
paging path, covering both the chevron buttons and `PageUp`/`PageDown`. Day
movement is **not** announced: focus lands on a button whose `aria-label` is the
full date, which the screen reader reads natively. Month changes driven from
outside (a `DatePickerPanel` preset) are not announced here — that press has its
own button label — so a month change is never spoken twice.

### Where the logic lives

The plugin's existing split is pure `core/` + thin `web/`. Keep it:

- **`core/`** — key → target-day resolution and focus-day selection, both pure
  `Date` functions, `bun:test`-able with no DOM. They reuse `addDays` /
  `addMonths` / `isSameMonth`, so DST and month-length clamping are already
  correct by construction.
- **`web/`** — roving tabindex, DOM focus, ARIA attributes.

No generic 2-D roving-tabindex primitive is introduced. There is none in the repo
today (confirmed: `tree`, `data-view`, `data-table`, `command-palette` all hand-roll
1-D or nothing), and a calendar's navigation is date arithmetic over an
*unbounded* index space (paging), not index math over a fixed matrix — a generic
hook would fight the domain. Noted as a follow-up if a second 2-D grid appears.

## Implementation

### 1. `core/internal/day-math.ts` — add week-edge helpers

```ts
export function startOfWeek(d: Date, weekStartsOn: number): Date
export function endOfWeek(d: Date, weekStartsOn: number): Date
```

Built on `normalizeWeekStart` + `addDays` (never epoch math), matching the
module's existing local-calendar rule. `buildMonthGrid`'s lead computation can be
expressed through `startOfWeek` so the week-start alignment has one definition.

### 2. `core/internal/grid-nav.ts` (new) — the pure key → day resolver

```ts
export interface DayNavIntent { readonly key: string; readonly shiftKey: boolean }

/** The day a navigation key moves to, or `null` when the key is not ours. */
export function resolveDayNavigation(
  intent: DayNavIntent,
  focused: Date,
  weekStartsOn: number,
): Date | null

/** The day that should carry `tabIndex=0` for the rendered month. */
export function pickFocusDay(opts: {
  weeks: Date[][];
  viewMonth: Date;
  value?: Date | null;
  today: Date;
  min?: Date;
  max?: Date;
}): Date
```

`null` here is a **predicate, not an absorbed failure** (same shape as
`fromISODay`): "this key is not a navigation key" is a legitimate answer the
caller branches on. Document that inline, matching the module's existing note.

### 3. `core/internal/labels.ts` — column-header and cell labels

- `weekdayLabels(weekStartsOn, locale)` changes its return type from `string[]`
  to `{ short: string; long: string }[]`. One `Intl` walk, one source of truth,
  so the visible abbreviation and the announced full name cannot drift. Only
  `calendar.tsx` and `labels.test.ts` consume it (verified — no cross-plugin
  importer).
- New `dayLabel(day, locale)` → `"Friday, August 21, 2026"` via
  `Intl.DateTimeFormat(locale, { weekday:"long", year:"numeric", month:"long", day:"numeric" })`.

### 4. `core/index.ts` — export `startOfWeek`, `endOfWeek`, `resolveDayNavigation`, `pickFocusDay`, `dayLabel`, `WeekdayLabel`

### 5. `web/components/calendar.tsx` — the rewrite

Replaces the two flat `<Grid>`s with the structure above, adds the `onKeyDown`
handler, the roving `tabIndex`, the `data-day` attribute, the focus-restoring
layout effect, and the `announce` call in `goToMonth`. The month title gets a
`useId()`-minted `id` that the grid's `aria-labelledby` points at. The stale
"No `role=grid`" comment is replaced by a short note explaining why the role is
now honest.

`CalendarProps` is unchanged — every existing consumer (`fields/date/filter`,
`fields/date/inline`, `page/inline-date`) keeps working untouched.

### 6. Tests

- `core/internal/grid-nav.test.ts` (new, `bun:test`) — every key including
  `Shift+PageUp/Down`, week-edge `Home`/`End` under several `weekStartsOn`
  values, month/year boundary crossing, a DST week, non-navigation keys → `null`,
  and `pickFocusDay`'s preference order incl. the "1st is disabled by `min`" and
  "whole month disabled" cases.
- `core/internal/day-math.test.ts` — cases for `startOfWeek`/`endOfWeek`.
- `core/internal/labels.test.ts` — updated for the `{short,long}` shape, plus
  `dayLabel`.
- `web/__tests__/calendar-grid.test.tsx` (new, vitest/RTL — the plugin's first
  DOM test) — asserts the role structure (1 grid, 7 rows, 7 columnheaders,
  42 gridcells), exactly one `tabIndex=0`, that `→` moves focus one day,
  that `↓` at the end of the month pages the view and keeps focus, and that
  `aria-selected` / `aria-current="date"` land on the right cells.

### 7. Docs

`plugins/primitives/plugins/date-picker/CLAUDE.md` gains a **"The month grid is a
real ARIA grid"** section: the row/columnheader/gridcell structure and why the
per-week nested grids (not `display:contents`), the keyboard table, the roving
rule, and the min/max-refusal choice. The "Composition" section's claim that the
grid *is* `<Grid cols={7}>` is corrected to seven of them.

## Verification

```bash
bun test plugins/primitives/plugins/date-picker/core          # pure day math + nav
bun run test:dom plugins/primitives/plugins/date-picker       # the DOM grid test
./equin check type-check eslint                         # lint rules incl. aria-safety
./equin build                                           # deploy
```

Then, in the deployed app at `http://<worktree>.localhost:9000`:

1. Open a task's detail and a date field (`fields/date/inline` → `DatePickerPopover`),
   or the page editor's `@` date mention (`page/inline-date`).
2. Tab into the calendar — focus should land on **one** day (the selected one, or
   today), not the 1st of 42.
3. Arrows walk the month; `↓` past the last week pages to the next month with
   focus on the correct day; `Home`/`End` jump to the week's edges;
   `PageUp`/`PageDown` page months, `Shift`+them page years; `Enter` picks.
4. With VoiceOver (`Cmd+F5`) on: entering the grid should announce
   "August 2026, grid", and each day "Friday, August 21, 2026, selected" /
   "…, current date", with the weekday column header read on column change.
5. Re-check the date-filter's "Exact date" section
   (`fields/date/filter`) — the bare `<Calendar>` consumer — for the same
   behaviour and no layout shift.

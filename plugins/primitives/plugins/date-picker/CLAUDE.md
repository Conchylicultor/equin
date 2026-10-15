# date-picker

The themed date-entry primitive. Before this plugin the only date UI in the repo
was the native `<input type="date">` — unthemeable, locale-opaque, and with no
place to put a relative preset ("Today") or a reminder time. Every surface that
needs a day now composes this instead.

## Local days, never UTC

**The one rule.** A "day" here is the user's *local* calendar day, and every
function in `core/` is written that way — via `Date` setters (`setDate`,
`setMonth`, `setHours`), never epoch arithmetic.

- `toISODay(d)` is **not** `d.toISOString().slice(0, 10)`. `toISOString` is UTC,
  so west of Greenwich every local evening serializes as the *next* day (and
  every early morning east of it as the *previous* one). That silent off-by-one
  is the bug class this module exists to close; `core/internal/day-math.test.ts`
  pins the divergence explicitly so nobody "simplifies" it back.
- `fromISODay(s)` returns local midnight, or `null` when `s` is not a
  well-formed calendar day. That `null` is a **parse predicate**, not an
  absorbed failure: the input is untrusted text (a stored operand, a URL param)
  and "not a date" is an expected answer the caller branches on. It also rejects
  syntactically valid but non-existent days (`2026-02-30`), which
  `new Date(y, m, d)` would otherwise roll silently into March.
- `addDays` survives DST because `setDate` re-resolves against the local
  calendar: on a spring-forward Sunday `+86_400_000` lands 23 hours later, i.e.
  still the *same* calendar day.
- `addMonths` **clamps** to the target month's length (Jan 31 + 1 month is
  Feb 28 / Feb 29), which is the one deliberate divergence from
  `fields/date/plugins/filter`'s `addUnits`. A raw `setMonth` overflows Feb 31
  into March 3 — invisible for that module's filter-window shift, but a visible
  bug for a month pager, which would skip February entirely.

`buildMonthGrid` always returns **6 rows × 7 days**, padded with adjacent-month
days. A month genuinely needs 4–6 rows, and a variable row count makes the
picker change height as you page — a reflow that moves everything below it.

## Why `Calendar` is separate from `DatePickerPanel`

Three consumers want three different amounts of the picker, so the pieces are
exported separately rather than behind one component with `showX` flags:

- **`Calendar`** — the bare month grid. The date-filter's "Exact date" section
  wants only this: it has its own *relative anchor* presets above it (which a
  calendar cannot express — see `fields/date/plugins/filter`) and no time
  concept. It seeds from `fromISODay(iso)` and emits `toISODay(day)`.
- **`TimeField`** — the clock half, a themed native `<input type="time">`.
  Native form controls are the documented exemption from `no-adhoc-control`;
  the platform's own 12h/24h locale handling and mobile time wheel are not worth
  re-deriving.
- **`DatePickerPanel`** — presets + calendar + optional time + optional Clear.
  The "whole picker" a chip or a cell editor opens.
- **`DatePickerPopover`** — the panel behind a trigger.

`DatePickerPanel` **controls the month** rather than letting `Calendar` keep its
own, so pressing a preset moves the visible month with it instead of leaving the
new selection off-screen. `Calendar` still supports the uncontrolled shape (omit
`month`/`onMonthChange`) for standalone use.

## Relative labels

`relativeDayLabel(date, now)` is the single source of the Today / Tomorrow /
Yesterday vocabulary, shared by the panel's preset row and the page editor's `@`
date menu, so the two can never disagree. `now` is a **required parameter** —
every caller already has the clock its surface renders against, and an implicit
`Date.now()` is what makes this kind of function untestable.

Do **not** merge it with `formatAnchor` in `fields/date/plugins/filter/core`.
That one labels a *relative anchor operand* (`{kind:"relative", unit, amount}` —
a rule that re-resolves as the clock advances); this one labels a *concrete
date*. They share three words and nothing else.

## The month grid is a real ARIA grid

A screen-reader user arrives at a day by arrow key, with no view of the month
around it, so the grid has to carry its own structure:

```
Stack   role="grid"  aria-labelledby={month title}  onKeyDown
├─ Grid cols={7}  role="row"                                   ← weekday header
│  └─ Center ×7   role="columnheader"  aria-label="Monday"
└─ Grid cols={7}  role="row"  ×6                               ← one per week
   └─ Center ×7   role="gridcell"  aria-selected
      └─ Button   aria-label="Friday, August 21, 2026"  tabIndex=0|-1
```

Each week is its **own** `<Grid cols={7}>` — seven of them, not one flat grid.
Columns still line up because every row has identical `repeat(7, minmax(0,1fr))`
tracks in a container of identical width. Do **not** collapse them back into one
flat grid with `display: contents` row wrappers: several screen readers drop
roles on `display:contents` elements, which puts you back at a grid announcing
as empty — the state `aria-safety/no-orphan-composite-role` exists to catch.

`role="gridcell"` goes on the `<Center>` box, never on the `<Button>`: a plain
`div` between `row` and `gridcell` would break the owned-element chain, and
overriding the button's role would cost its native "button" announcement.
`aria-selected` is the grid's own selection carrier and sits on the cell — a day
is a selected cell, not a pressed toggle. Today carries `aria-current="date"`,
the spoken counterpart of its visual ring.

### Keyboard

One handler on the grid container, so it works wherever focus is. The key → day
mapping is pure (`core/internal/grid-nav.ts`), built on `addDays` / `addMonths`
/ `startOfWeek` so DST and month-length clamping are correct by construction.

| Key | Effect |
| --- | --- |
| `←` / `→` | ∓1 day |
| `↑` / `↓` | ∓7 days |
| `Home` / `End` | first / last day of the focused week (`weekStartsOn`-aligned) |
| `PageUp` / `PageDown` | ∓1 month |
| `Shift+PageUp` / `Shift+PageDown` | ∓1 year |
| `Enter` / `Space` | native `<button>` activation — no custom handling |

Crossing a month boundary pages the view and keeps focus on the day you moved
to. A move onto a day outside `min`/`max` is **refused** — focus stays put —
rather than clamped or skipped past: the bounds are a contiguous range, so there
is never a hole to jump over, and stopping at the end is what every other range
control does.

### One tab stop, derived not stored

Exactly one day button carries `tabIndex=0`, so entering the calendar costs one
Tab rather than 42. The target is **derived** every render:

```
activeDay = isSameMonth(focusedDay, viewMonth) ? focusedDay : pickFocusDay(…)
```

so a `focusedDay` left over from a month the user has paged away from can never
strand the tab stop off-screen, and no synchronising effect is needed (keyboard
navigation sets the focused day and the view month together; a click sets the
focused day too, so arrows continue from the day you clicked). `pickFocusDay`
prefers the selected day, then today, then the 1st — taking the first that is
inside the view month **and in bounds**. That last clause is load-bearing: with a
`min` starting mid-month, a `tabIndex=0` on the disabled 1st would drop the whole
calendar out of the tab order, since a disabled button is not focusable.

DOM focus moves after the state commit — the handler records the target's ISO day
in a ref and a layout effect focuses `[data-day="<iso>"]` — because paging
re-renders the whole grid, so the button to focus may not exist when the key is
handled.

Paging announces the new month via `announce()` from `goToMonth`, covering both
the chevrons and `PageUp`/`PageDown`. Day movement is not announced: focus lands
on a button whose `aria-label` is the full date, which the screen reader reads
natively.

## Composition

Hand-rolled on the existing layout primitives — no new dependency, no vendored
shadcn `Calendar` (which would ship raw Tailwind tripping `no-adhoc-layout` /
`-spacing` / `-radius` and need rewriting anyway). The month is seven
`<Grid cols={7}>` rows (see above); day cells are
`<Button aspect="icon" shape="pill">` under a `<ControlSizeProvider size="sm">`,
so they follow the active theme's radius and density tokens for free. The header
is the canonical `Line` + `Fill` + rigid `IconButton` row.

## Tests

`bun test plugins/primitives/plugins/date-picker/core` — pure day math, labels
and grid navigation: DST boundaries in both directions, `addMonths` clamping and
rollover, `buildMonthGrid`'s 6×7 invariant and week-start alignment, `toISODay` /
`fromISODay` round-trip over a full year, `relativeDayLabel` at local midnight
edges, every navigation key (incl. `Shift+Page*` and non-navigation keys → `null`)
and `pickFocusDay`'s preference order under `min`/`max`. The suite is
timezone-independent by construction and is run under `TZ=America/Los_Angeles`
(a negative offset with DST — the configuration where the UTC bug class is
visible at all).

`bun run test:dom plugins/primitives/plugins/date-picker` — the rendered grid:
role structure and counts, the single `tabIndex=0` (and that it never lands on a
disabled day), arrow/Home/End/Page focus moves including the month page, the
refused out-of-bounds move, and where `aria-selected` / `aria-current` land. The
clock is pinned with `vi.setSystemTime` so "today" is deterministic.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Themed date-picker primitive: <Calendar> month grid, <TimeField> native clock input, <DatePickerPanel> (presets + calendar + time + clear), and <DatePickerPopover>. Day math lives in core/ and is local-calendar, never UTC.
- Web:
  - Uses:
    - `primitives/announce.announce`
    - `primitives/css/center.Center`
    - `primitives/css/cluster.Cluster`
    - `primitives/css/fill.Fill`
    - `primitives/css/grid.Grid`
    - `primitives/css/line.Line`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.Button`
    - `primitives/css/ui-kit.cn`
    - `primitives/css/ui-kit.ControlSizeProvider`
    - `primitives/css/ui-kit.Separator`
    - `primitives/icon-button.IconButton`
    - `primitives/overlay/popover.InlinePopover`
    - `primitives/overlay/popover.InlinePopoverProps`
    - `ui/icons.Icon`
  - Exports (types):
    - `CalendarProps`
    - `DatePickerPanelProps`
    - `DatePickerPopoverProps`
    - `TimeFieldProps`
  - Exports (values):
    - `Calendar`
    - `DatePickerPanel`
    - `DatePickerPopover`
    - `TimeField`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --input`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/density --space-2xs`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-scale`
    - `ui/tokens/type-scale --font-size-body`
    - `ui/tokens/type-scale --font-weight-normal`
    - `ui/tokens/type-scale --line-height-body`
  - Imported by:
    - `fields/date/data-view-group`
    - `fields/date/filter`
    - `fields/date/inline`
    - `page/inline-date`
- Core:
  - Exports (types):
    - `DayNavIntent`
    - `RelativeDayLabel`
    - `WeekdayLabel`
  - Exports (values):
    - `addDays`
    - `addMonths`
    - `buildMonthGrid`
    - `dayLabel`
    - `endOfWeek`
    - `fromISODay`
    - `isDayInBounds`
    - `isSameDay`
    - `isSameMonth`
    - `monthTitle`
    - `normalizeWeekStart`
    - `pickFocusDay`
    - `relativeDayLabel`
    - `resolveDayNavigation`
    - `startOfDay`
    - `startOfMonth`
    - `startOfWeek`
    - `toISODay`
    - `weekdayLabels`

<!-- AUTOGENERATED:END -->

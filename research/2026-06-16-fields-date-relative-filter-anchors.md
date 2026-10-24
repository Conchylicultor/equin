# DataView date filters: relative-anchor values

## Context

The DataView date-field filter operators (`is`, `is before`, `is after`,
`is on or before`, `is on or after`, `is between`) currently only accept an
**absolute** ISO `yyyy-mm-dd` operand entered through a native `<input type="date">`.
Notion lets users filter against **relative** anchors evaluated at filter time —
"Today", "Yesterday", "Tomorrow", "N days/weeks/months/years ago/from now", and
range operators like "is within the past/next week". The reference screenshot
shows `is on or before · Today`. We want the same relative-anchor values so a
saved filter like "due on or before Today" stays correct as the clock advances.

Intended outcome: every scalar date operator can take either an absolute date or
a relative anchor; `is between` accepts an anchor on each bound; and two new
relative-range operators (`is within the past`, `is within the next`) are added.
All relative values resolve against `now` at the moment the filter runs.

## Scope & boundaries

Entirely inside `plugins/fields/plugins/date/plugins/filter/`. No changes to the
data-view primitive, the view-state config schema, or any load-bearing infra:
`FilterRule.value` is already `unknown` (Zod `z.unknown().optional()`) and the
`FilterOperator.predicate` signature is already `(operand: unknown, fieldValue) => boolean`,
so the new operand shapes are JSON-safe and need no schema work. Backward compat:
existing stored operands are plain ISO strings and must keep resolving as
absolute dates.

## Operand model (new pure module)

New file `web/internal/date-anchor.ts` — pure, `now`-injectable, fully unit-tested:

```ts
export type DateUnit = "day" | "week" | "month" | "year";

// Discriminated union stored in FilterRule.value. JSON-serializable.
export type DateAnchor =
  | { kind: "date"; iso: string }                          // absolute calendar day
  | { kind: "relative"; unit: DateUnit; amount: number };  // now ± amount units (signed: <0 ago, >0 from now)

export const TODAY: DateAnchor;        // { kind: "relative", unit: "day", amount: 0 }

// Resolve an anchor (or a legacy bare ISO string) to start-of-(local)-day epoch ms, or null.
export function resolveAnchorDay(operand: unknown, now?: number): number | null;

// Calendar-safe shift using Date setters (DST/month-length correct): day/week via setDate, month/year via setMonth/setFullYear.
export function addUnits(t: number, unit: DateUnit, amount: number): number;

// Human label: "Today" / "Yesterday" / "Tomorrow" / "3 days ago" / "2 weeks from now" / "Jan 15, 2026".
export function formatAnchor(operand: unknown): string;
```

Resolution rules in `resolveAnchorDay`:
- `null` / `""` → `null` (incomplete rule).
- `string` → legacy absolute: `startOfDay(new Date(str))`.
- `{ kind: "date", iso }` → `startOfDay(new Date(iso))`.
- `{ kind: "relative", unit, amount }` → `addUnits(startOfDay(now), unit, amount)`.

`now` defaults to `Date.now()` (this is browser predicate code; `Date.now()` is
fine here — only workflow scripts ban it). The default keeps the
`FilterOperator.predicate` signature intact; the param exists purely so unit
tests can pin `now`.

## Predicates (`web/internal/date-filter-logic.ts`)

- Replace the private `operandDay` with a call to `resolveAnchorDay` (keep
  `fieldDay` / `startOfDay` as-is). The existing `dayCmp`-built operators
  (`is`, `isBefore`, `isAfter`, `isOnOrBefore`, `isOnOrAfter`) then accept both
  absolute strings, `{kind:"date"}`, and `{kind:"relative"}` operands unchanged.
- `DateRange` becomes `{ from?: DateAnchor | string; to?: DateAnchor | string }`;
  `isBetween` resolves each bound via `resolveAnchorDay`. The `to` bound stays
  inclusive-of-the-whole-day.
- Add two relative-range operators. Operand: `{ unit: DateUnit; amount: number }`
  (magnitude, default `{unit:"week",amount:1}`; direction implied by operator).
  Export a pure, `now`-injectable helper for testability:
  ```ts
  export function withinRange(operand, direction: "past"|"next", now?): [number, number] | null;
  export function isWithinPast(operand, fieldValue): boolean;  // field day in [today - N units, today]
  export function isWithinNext(operand, fieldValue): boolean;  // field day in [today, today + N units]
  ```
  Both bounds inclusive (whole-day on the upper bound, mirroring `isBetween`).

## Operator set (`web/operator-set.ts`)

Append after `is-between`:
- `{ id: "is-within-past", label: "Is within the past", hasValue: true, ValueInput: RelativeRangeInput, predicate: isWithinPast }`
- `{ id: "is-within-next", label: "Is within the next", hasValue: true, ValueInput: RelativeRangeInput, predicate: isWithinNext }`

(`is-empty` / `is-not-empty` stay last.)

## Value-input UI (`web/components/date-filter.tsx`)

Rebuild `DateValueInput` as a popover-triggered **anchor chooser** (Notion-style):

- **Trigger**: a control-height button (compose existing primitives — `Popover`
  wrapper, `Button`/`IconButton`, control-size scale) labelled `formatAnchor(value)`
  or a muted "Select date" placeholder, with a small calendar/▾ affordance.
- **Popover body** (use `Stack`/`Inset` spacing primitives, `Row` for option
  rows, `section-label` for group headers, `Text` for labels — no ad-hoc
  spacing/typography/radius):
  1. Quick presets as rows: **Today**, **Yesterday**, **Tomorrow** (write the
     corresponding `{kind:"relative"}` anchor, close popover).
  2. A **custom relative** row: numeric amount input + unit `<select>`
     (days/weeks/months/years) + direction `<select>` (ago / from now),
     composing into `{kind:"relative", unit, amount: ±n}`.
  3. An **Exact date** row containing `<input type="date">` that writes
     `{kind:"date", iso}`.
- Normalize the incoming `value`: a bare string → render as an exact date
  (`{kind:"date"}`), so legacy operands display correctly.

`DateRangeInput` (for `is-between`): two of the same anchor choosers, one per
bound, each storing a `DateAnchor` into `{from,to}`.

`RelativeRangeInput` (for the within operators): the relative-magnitude builder
only — numeric amount + unit `<select>` — emitting `{unit, amount}` (no
direction; default shown is `1 week`).

Keep all three components small and presentational; share the relative-builder
and exact-date sub-pieces between them within this file.

## Files

- **New** `web/internal/date-anchor.ts` — operand model, resolver, `addUnits`, `formatAnchor`.
- **New** `web/internal/date-anchor.test.ts` — `resolveAnchorDay`/`addUnits`/`formatAnchor` with pinned `now` (Today/Yesterday/Tomorrow/N-units/legacy-string/month-end calendar cases).
- **Edit** `web/internal/date-filter-logic.ts` — use `resolveAnchorDay`; widen `DateRange`; add `withinRange`/`isWithinPast`/`isWithinNext`.
- **Edit** `web/internal/date-filter-logic.test.ts` — add relative-anchor + within cases (pin `now` via the helpers).
- **Edit** `web/operator-set.ts` — register the two within operators.
- **Edit** `web/components/date-filter.tsx` — anchor-chooser `DateValueInput` + `DateRangeInput`, new `RelativeRangeInput`.
- **Edit** `web/CLAUDE.md` (filter sub-plugin) — note relative anchors + within operators.

## Verification

1. `bun test plugins/fields/plugins/date/plugins/filter/web/internal/` — anchor + predicate logic (pinned `now`).
2. `./equin build`, then open a DataView with a date field
   (e.g. a tasks/data surface) at `http://<worktree>.localhost:9000`.
3. Add a date filter, pick operator `Is on or before`, choose **Today** → rows
   filter relative to today; reload and confirm the relative value persists and
   re-resolves (still "Today", not frozen to a date).
4. Exercise a custom relative value ("3 days ago"), `is between` with mixed
   absolute+relative bounds, and `is within the past 1 week`.
5. Confirm a pre-existing absolute-string filter still works (backward compat).

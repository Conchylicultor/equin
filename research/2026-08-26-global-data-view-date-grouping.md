# Date-field grouping in DataView

_2026-08-26 — design plan_

## Context

On `/events/list` you can group by Category or Source, but not by **When** — the
date field is absent from the Group by menu entirely. Two things cause that, and
both are the same root problem: **data-view buckets rows itself, by hardcoded
field type.**

- `bucketKey(value)` is `String(value)`
  (`data-view/web/internal/use-data-view-sections.ts:40`). A `Date` stringifies
  to a full timestamp, so every row would land in its own group.
- `isGroupableField` is `field.groupable ?? (type === "enum" || type === "bool")`
  (same file, `:21`) — a literal type list living inside the primitive.
- `sectionLabel` (`:44`) hardcodes the enum options lookup and `bool → Yes/No`,
  and `partitionIntoSections` (`:106`) hardcodes "enum sections follow
  `field.options` order".

So data-view names three field types by string and knows how each of them
buckets. Adding dates by adding a fourth branch would make that worse.

**What we want instead:** a field *type* declares how it buckets, the same way it
already declares its cell, its filter, its SQL cast and its value codec — five
sibling sub-plugins under `plugins/fields/plugins/date/plugins/`. The `date` type
then contributes five groupings:

| | |
|---|---|
| **Smart** | relative to today, coarsening with distance — Today, Tomorrow, Later this week, Next week, Later this month, Later this year, Later (and the mirror image into the past: Yesterday, Earlier this week, Last week, …). The Gmail behaviour. |
| **Day / Week / Month / Year** | one fixed granularity, absolute labels. |

and data-view is left with pure mechanism: it partitions, orders and renders
sections without naming a single field type.

**Outcome:** every DataView in the app with a date field gains date grouping at
once — Events, Mail threads, source runs, slow ops — and the Events "Upcoming"
view ships grouped by Smart.

### Three judgment calls made here

I intended to put these to you before writing; the question was interrupted, so
they are decided below with reasons. Each is cheap to reverse — say the word.

1. **"Smart" means relative-to-now**, not "pick a granularity from the data
   range". Your examples ("Today", "This week", "This month") describe the
   relative reading. The contract below is a *factory* (`plan(ctx) → bucket`)
   precisely so a range-derived "Auto" grouping is later one more entry in the
   registry, with no change to data-view.
2. **Date fields become groupable everywhere by default** — groupability is
   derived from "does this type have a registered grouping?" rather than a type
   list. Enum/bool behave exactly as today; text/number stay out; any field can
   still opt out with `groupable: false`.
3. **Grouping stays client-side**, over the rows currently loaded — the same as
   enum grouping works today for the server-paginated Events list. Step 7
   (optional) stops the group counts from *lying* about it.

---

## The end-user experience

**In the view settings popover** — picking a date field reveals a second band:

```
Group by                          Group dates by
  ○ None                            ● Smart
  ○ Category                        ○ Day
  ○ Source                          ○ Week
  ● When                            ○ Month
  ○ Disappeared                     ○ Year
```

**The list, on `/events/list`:**

```
▾ Today                        3
    Salsa Intermediate · 19:00 · Geneva
    …
▾ Tomorrow                     2
▾ Later this week              7
▾ Next week                    4
▾ Later this month            11
▾ Later this year             26
```

**In config** — `config/apps/events/event-list/events.list.jsonc`:

```jsonc
{
  "name": "Upcoming",
  "view": {
    "type": "list",
    "groupBy": { "fieldId": "startsAt", "groupingId": "smart" },
    "sort": [{ "fieldId": "startsAt", "direction": "asc" }],
    "filter": { … }
  }
}
```

**A field type declaring how it buckets** —
`plugins/fields/plugins/date/plugins/data-view-group/web/index.ts`, the whole file:

```ts
export default {
  description: "Date field type: data-view grouping strategies (smart, day, week, month, year).",
  contributions: [
    DataViewSlots.Grouping({
      match: "date",
      label: "Group dates by",
      groupings: dateGroupings,
    }),
  ],
} satisfies PluginDefinition;
```

---

## The contract

New, in `data-view/core/internal/grouping.ts` (exported from `data-view/core`):

```ts
/** One way to bucket a field's values — persisted by `id` in the view config. */
export interface FieldGrouping {
  readonly id: string;      // "smart" | "day" | "month" | "value" | …
  readonly label: string;   // "Smart", "Day", "Month"
  /**
   * Build the bucketing function for ONE render. Two-phase on purpose: a
   * grouping that needs to see the whole set before it can order its sections
   * (enum by `options` index, the identity fallback by value order, a future
   * range-derived "Auto") does that work once here, not per row.
   */
  readonly plan: (ctx: GroupingPlanContext) => (value: FieldValue) => GroupBucket;
}

export interface GroupingPlanContext {
  /** Local midnight of the current day. Injected — never read the clock inside a grouping. */
  readonly now: number;
  /** Every non-null value in the rows being partitioned. */
  readonly values: readonly FieldValue[];
  /** The field being grouped — `options`, `label`, per-field settings. */
  readonly field: FieldDef<unknown>;
}

export interface GroupBucket {
  /** Bucket identity. Stable across renders — it keys the collapse state. */
  readonly key: string;
  /** The section header text. */
  readonly label: string;
  /** Chronological/natural ordinal. Sections sort on this; see "Section order". */
  readonly order: number;
}

/** The persisted group-by choice. Replaces the bare `groupBy: string`. */
export interface GroupByRule {
  readonly fieldId: string;
  readonly groupingId: string;
}
```

`now` being a required, injected parameter follows the precedent set by
`relativeDayLabel(date, now)` in `date-picker/core/internal/labels.ts:31`, whose
doc comment already argues the case ("an implicit clock read is exactly what
makes this kind of function untestable"). It is also *required* for correctness
here: `partitionIntoSections` runs inside a `useMemo`, so a raw `Date.now()`
would change the memo key on every render.

### Section order

`GroupBucket.order` is a plain ascending ordinal — epoch-ms of the bucket start
for the fixed granularities, `−7…+7` for Smart (past negative, Today 0, future
positive). Sections then render **ascending or descending according to the
view's own sort direction on the grouped field**, so both readings come out
right with no extra config:

- Events "Upcoming" sorts `startsAt asc` → Today, Tomorrow, Later this week…
- Events "All" sorts `startsAt desc` → newest month first. Gmail's reading.

One wrinkle to handle: for a server-delegated source, `data-view-body.tsx:244`
zeroes `sort` in `effectiveState` (the server already sorted), so the views
cannot read it. `data-view-body` therefore computes the direction once from
`activeState.sort` and passes it down as a new `DataViewRenderProps.groupOrder`,
alongside the existing `collapsedSections` / `setSectionCollapsed`.

### The Smart buckets

Fifteen buckets, symmetric around today, all boundaries **local calendar** via
`date-picker/core`'s `startOfDay` / `startOfWeek` / `startOfMonth` / `addDays` /
`addMonths` (that plugin's rule: "a day here is the user's local calendar day
… via `Date` setters, never epoch arithmetic"). Week starts Monday
(`normalizeWeekStart(1)`) — a one-line constant.

| order | key | label | | order | key | label |
|---|---|---|---|---|---|---|
| −7 | `older` | Older | | +1 | `tomorrow` | Tomorrow |
| −6 | `earlier-year` | Earlier this year | | +2 | `this-week` | Later this week |
| −5 | `last-month` | Last month | | +3 | `next-week` | Next week |
| −4 | `earlier-month` | Earlier this month | | +4 | `this-month` | Later this month |
| −3 | `last-week` | Last week | | +5 | `next-month` | Next month |
| −2 | `earlier-week` | Earlier this week | | +6 | `later-year` | Later this year |
| −1 | `yesterday` | Yesterday | | +7 | `later` | Later |
| 0 | `today` | Today | | | | |

Disjoint and exhaustive; a bucket with no rows simply never appears. Null values
keep the existing `NULL_GROUP_KEY` "None" section, ordered last as today.

Fixed granularities: **Day** keys on `toISODay`, labelled by `relativeDayLabel`
when within ±1 and an absolute date otherwise; **Week** → "Week of 24 Aug";
**Month** → "August 2026"; **Year** → "2026". All labels via `Intl`, matching
`labels.ts`.

---

## Implementation

### 1. The grouping slot — `plugins/primitives/plugins/data-view/`

- `core/internal/grouping.ts` — the types above; re-export from `core/index.ts`.
- `web/grouping-slot.ts` — `defineSlot<{ match: string; label: string; groupings: FieldGrouping[] }>`
  plus `useResolveGroupings(typeId)`, which walks `resolveTypeChain` and returns
  the first match. **Copy `web/value-codec-slot.ts` byte-for-byte** — it is the
  closest sibling (a plain data slot, not a dispatch slot, since a grouping is a
  pure function set, not a component). Export as `DataViewSlots.Grouping` from
  `web/slots.ts` alongside `Cell` / `Filter` / `ValueCodec` / `ColumnConfig`.
- `web/internal/identity-grouping.ts` — the built-in `{ id: "value", label: "Value" }`
  fallback: `key`/`label` are `String(value)`, `order` is the value's index in
  `ctx.values` sorted by the existing `compareValues`. This is what makes an
  explicit `groupable: true` on *any* type keep working, and what the legacy
  `groupBy: "<field>"` string migrates to.

### 2. Make `partitionIntoSections` type-blind — `use-data-view-sections.ts`

The heart of the change. All three hardcoded branches go:

- `isGroupableField(field, hasGrouping)` — takes a `(typeId) => boolean`
  predicate; the default becomes `field.groupable ?? hasGrouping(type)`. The
  `enum`/`bool` literals are deleted. (Behaviour is preserved exactly once step 3
  lands: enum and bool contribute groupings, `dynamic-enum`/`text`/`number` do
  not — and none of them are groupable today either.)
- `sectionLabel` and the enum-options ordering block are **deleted**; labels and
  order come from the bucket.
- `partitionIntoSections(rows, fields, groupBy, rowKey, opts)` gains
  `{ resolveGrouping, now, order }`. It stays pure and its existing test file
  (`use-data-view-sections.test.ts`) is updated to pass a stub resolver.
- `useDataViewSections` threads the same three through — mirroring how it already
  injects `resolveOperatorSet`.

### 3. Move enum/bool out of data-view

Two new sub-plugins, each a one-contribution barrel following the `date/plugins/*`
convention exactly:

- `plugins/fields/plugins/enum/plugins/data-view-group/` — `{ id: "value", label: "Value" }`,
  label from `ctx.field.options`, `order` = index in `options` (unknown values
  after known, value-sorted — preserving today's rule).
- `plugins/fields/plugins/bool/plugins/data-view-group/` — Yes/No, `order` 0/1.

This is what makes the design honest: after it, data-view names no field type.
It is also the one step with regression surface (Pages `origin`, Events
`by-category`, the tasks tree) — verify those three explicitly.

### 4. The clock — `web/internal/use-grouping-clock.ts`

Returns `startOfDay(Date.now()).getTime()`, memoized, and arms **one**
`setTimeout` for the next local midnight that bumps it and re-arms. This is not
polling: it fires exactly at the boundary where the value changes, which is the
"no `setInterval` loops to check for changes" rule's own criterion. Without it a
view left open overnight keeps saying "Today". Document the reasoning in the file.

### 5. The persisted rule and the UI

- `use-data-view-model.ts` — `readGroupBy` becomes a **migrate-on-read**, copying
  `readSortRules` (`:84-89`) line for line and inheriting its doc comment's
  contract (never destructive; re-serialized only when the user next edits):
  `string → { fieldId: raw, groupingId: "value" }`, object → as-is, else
  `undefined`. `setGroupBy(id, rule)` writes the object; `undefined` still erases
  the key via `mergeView`'s existing undefined-drop. **No committed config file
  needs editing** — `config/apps/events/event-list/events.list.jsonc`'s
  `"groupBy": "category"` migrates silently, and `variantField`'s passthrough
  schema never validated the key anyway.
- `ViewState.groupBy` becomes `GroupByRule | undefined` (`core/internal/types.ts:382`).
- `use-group-by-controller.ts` — also resolves the active field's groupings and
  exposes `groupingId` / `setGrouping`; the "dangling field" tolerance extends to
  a dangling `groupingId` (falls back to the first grouping).
- `group-by-control.tsx` — after the existing field radio band, a second
  `ControlPanel.Section` labelled from the contribution's `label`, rendered only
  when the active field offers more than one grouping. Two bands rather than a
  `usePanelStack` push (the precedent is `add-sort-affordance.tsx`): the choice
  is small and closed, and seeing granularity next to field is the point.

### 6. Wire the four views

`data-view-body.tsx` computes `groupOrder` from `activeState.sort` and passes
`now` + `groupOrder` through `DataViewRenderProps`. Each view forwards them:
`plugins/list/…/list-view.tsx:135`, `plugins/table/…/table-view.tsx:81`,
`plugins/gallery/…/gallery-view.tsx:131` (all via `useDataViewSections`), and
`plugins/tree/…/tree-view.tsx:324` (direct `partitionIntoSections`).

### 7. Optional — stop the counts from lying

A section header currently prints `section.count`, which for a server-paginated
source is the count *of what has loaded*. That is pre-existing, but date grouping
makes it conspicuous ("Today 3" while 40 more sit unfetched). Render `3+` while
the source has more pages: one `exhaustive` flag from `data-view-body`'s server
handle, through render props, into one shared `formatSectionCount(count, exhaustive)`
used by both header sites (`grouped-sections.tsx` and `table-view.tsx:258-284`).
**Cut this step freely** — it is honesty polish, not the feature.

### 8. The payoff view

In `config/apps/events/event-list/events.list.jsonc`, add
`"groupBy": { "fieldId": "startsAt", "groupingId": "smart" }` to the **Upcoming**
view. Its `is-on-or-after today` filter means only the forward buckets appear —
Today, Tomorrow, Later this week, … — which is exactly the surface you pointed at.

---

## Testing

Co-located pure-logic suites (bun:test, next to source):

- `fields/date/plugins/data-view-group/core/internal/date-groupings.test.ts` —
  pin `now` to a local literal the way `date-anchor.test.ts:NOW` does. Cover: all
  15 Smart buckets from one pinned day; the boundary pairs (23:59 today vs 00:00
  tomorrow, Sunday→Monday week edge, month-end, year-end); DST (a spring-forward
  day still buckets as one day); each fixed granularity's key/label/order; a null
  value.
- `data-view/web/internal/use-data-view-sections.test.ts` — extend: a grouping's
  `order` drives section order; `order: "desc"` reverses it; the None bucket stays
  last in both directions; `isGroupableField` follows the injected predicate;
  identity fallback reproduces today's output.

```bash
./equin test plugins/fields/plugins/date
./equin test plugins/primitives/plugins/data-view
```

## Verification

```bash
./equin build          # run_in_background: true — regenerates the plugin registry
./equin check
```

Then at **http://att-1787735159-jjcf.localhost:9000/events/list**:

1. Settings gear → Group by now lists **When** and **Disappeared**. Pick When →
   the "Group dates by" band appears → Smart.
2. The list breaks into Today / Tomorrow / Later this week / … Counts match the
   rows in each section; collapsing a section persists across reload.
3. Switch to Day, Week, Month, Year — labels and order change, sections stay
   correct.
4. Switch to the **All** tab (sorted `startsAt desc`), group by Month → newest
   month first. Confirms the sort-derived section order.
5. Regression, the three existing grouped surfaces: Events **By category**
   (enum option order and labels unchanged), Pages sidebar (Mine / Agent
   sections), the tasks tree grouped by category.

A repeatable pass is worth writing as
`plugins/primitives/plugins/data-view/e2e/date-grouping-verify.ts` using the
shared harness (`--click` the settings trigger, assert the section headers).

## Files

**New**
- `plugins/primitives/plugins/data-view/core/internal/grouping.ts`
- `plugins/primitives/plugins/data-view/web/grouping-slot.ts`
- `plugins/primitives/plugins/data-view/web/internal/identity-grouping.ts`
- `plugins/primitives/plugins/data-view/web/internal/use-grouping-clock.ts`
- `plugins/fields/plugins/date/plugins/data-view-group/` (core + web + test)
- `plugins/fields/plugins/enum/plugins/data-view-group/`
- `plugins/fields/plugins/bool/plugins/data-view-group/`

**Modified**
- `data-view/web/internal/use-data-view-sections.ts` (the core change)
- `data-view/web/internal/use-data-view-model.ts`, `use-group-by-controller.ts`
- `data-view/web/components/settings/group-by-control.tsx`
- `data-view/web/components/data-view-body.tsx`, `web/slots.ts`, `core/internal/types.ts`
- the four view children (`list` / `table` / `gallery` / `tree`)
- `config/apps/events/event-list/events.list.jsonc`
- `data-view/CLAUDE.md`, `fields/plugins/date/CLAUDE.md` (prose; the autogen
  blocks are regenerated by `./equin build`)

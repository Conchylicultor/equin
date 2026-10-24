# Date-picker primitive + inline `@` date-mention UX

## Context

Three complaints about the Pages editor's inline `@` date mention
(`plugins/page/plugins/inline-date/`), all symptoms of the same gap — **date entry in
this app is text-only, and the text grammar is invisible**:

1. **`@today` doesn't read as "Today".** With an empty query the menu offers rows labelled
   `Today` / `Tomorrow`; the moment you type anything those disappear. `@tod` falls into the
   `hint` branch (`"Keep typing a date…"`, zero rows — nothing to press Enter on), and `@today`
   parses but relabels itself as the absolute `Mon, Aug 3`. The preset vocabulary the menu
   advertises at rest is unreachable once you start typing it.
2. **The accepted format is undiscoverable.** Nothing in the UI states what chrono will parse.
   The only feedback is a menu that silently closes when the query stops looking like a date
   (`buildMenu`'s `KEYWORDS` gate), which reads as a bug rather than as guidance.
3. **The chip is a dead end.** `DateMentionView` renders a `LinkChip` whose only handler is
   `onClick={(e) => e.stopPropagation()}`. A wrong date can only be fixed by deleting the chip
   and retyping the whole mention.

**On "does a primitive already exist?" — no.** There is no calendar or date-picker component in
the repo, and no `react-day-picker`/`date-fns` dependency. The only date-entry UI anywhere is
the native `<input type="date">`, in exactly two places (`fields/date/plugins/inline`,
`fields/date/plugins/filter`). So (3) needs a primitive built, and this plan builds it once and
drains every native date input in the repo.

Intended outcome: one themed `date-picker` primitive; the `@` menu keeps its preset vocabulary
alive while typing and states its grammar; the chip opens that picker; and no
`<input type="date">` remains.

## Design

### 1. New primitive — `plugins/primitives/plugins/date-picker/`

Hand-rolled on the existing layout primitives (no new dependency). `Grid cols={7}` already
expresses a month grid exactly (`gridTemplateColumns` → `repeat(7, minmax(0,1fr))`), and
`Button` + `ControlSizeProvider` give lint-clean, theme-following day cells — a vendored
shadcn `Calendar` would ship raw Tailwind that trips `no-adhoc-layout` /
`no-adhoc-spacing` / `no-adhoc-radius` and need rewriting anyway.

**`core/` — pure day math + labels (runtime-agnostic, no DOM, bun:test-able).** This is the
load-bearing part: the whole class of date bugs is timezone/DST/month-rollover arithmetic, and
it belongs in one tested module rather than in three consumers.

- `startOfDay(d)`, `addDays(d, n)`, `addMonths(d, n)`, `isSameDay(a, b)` — via `Date` setters,
  so DST and month-length rollover stay correct. Mirror the technique already proven in
  `plugins/fields/plugins/date/plugins/filter/core/internal/date-anchor.ts:addUnits`.
- `toISODay(d): string` / `fromISODay(s): Date | null` — **local**-midnight ↔ `yyyy-mm-dd`.
  Note the existing `DateEditor` uses `d.toISOString().slice(0,10)`, which is UTC and therefore
  off by one day for anyone west of Greenwich after 00:00 local; `toISODay` fixes that class.
- `buildMonthGrid(month, weekStartsOn): Date[][]` — always 6×7, leading/trailing days from the
  adjacent months (stable height, no reflow when paging months).
- `relativeDayLabel(date, now): "Today" | "Tomorrow" | "Yesterday" | null` — the single source
  of the relative vocabulary, shared by the calendar's preset row and the `@` menu, so the two
  can never disagree. (`formatAnchor` in `date-anchor.ts` has its own copy of this vocabulary
  for *relative anchors*; that one stays — it labels a `{kind:"relative"}` operand, not a
  concrete date. Do not merge them.)
- `weekdayLabels(weekStartsOn, locale?)`, `monthTitle(month, locale?)` — `Intl`-driven.

**`web/` — components.** Deliberately three separable pieces, because the three consumers need
different amounts of it:

- `<Calendar value onSelect month onMonthChange weekStartsOn min max />` — the month grid alone.
  `Grid cols={7}` for the weekday header row and the day grid; each day a
  `Button aspect="icon" shape="pill"` (`ghost`, `variant="default"` when selected, muted for
  adjacent-month days, ring for today), inside a `ControlSizeProvider size="sm"`. Header is a
  `Line` + `Fill` with prev/next `IconButton`s.
- `<TimeField value onChange />` — native `<input type="time">` with the repo's existing
  `NATIVE_CONTROL` class recipe (native inputs are the documented exemption from
  `no-adhoc-control`).
- `<DatePickerPanel value onChange withTime presets onClear />` — `Calendar` + a quick-preset
  `Cluster` (Today / Tomorrow / Yesterday, from `relativeDayLabel`) + optional `TimeField` +
  Clear. This is the "whole picker" the chip wants.
- `<DatePickerPopover trigger … />` — thin `InlinePopover` wrapper around the panel.

Keep it one plugin, not sub-plugins: the API is closed and cohesive. If a range mode is ever
needed, *that* is the sub-plugin.

### 2. `@` menu — `plugins/page/plugins/inline-date/`

Only `web/internal/date-options.ts` and the menu render in
`web/components/inline-date-plugin.tsx` change; the caret-trigger wiring, the token grammar,
and the whole server reminder pipeline are untouched.

`DateOption` gains `detail?: string` (a trailing muted absolute date, so a relative label never
hides which day it means).

`buildMenu(query, now)`:

- **Presets become a filtered list, not an empty-query special case.** A `PRESETS` table
  (`Today` +0, `Tomorrow` +1, `Yesterday` −1) is emitted when the query is empty *and* when the
  query is a case-insensitive prefix of a preset label. `@tod` therefore yields a real, pressable
  `Today` row — the direct fix for complaint (1).
- **A parsed date is labelled relatively when it can be**:
  `relativeDayLabel(date, now) ?? formatDay(date)`, with `detail: formatDay(date)`. `@today`
  reads `Today — Mon, Aug 3`. Dedupe a preset row against the parsed row when they land on the
  same calendar day (`isSameDay`), so `@today` shows one date row, not two.
- The reminder row is unchanged (`Remind me · …`, 09:00 default when no time is certain).
- The `hint` state survives only for "looks like a date, nothing resolved yet" (`@nex`).

Render: the `Row` list gains the muted `detail` as a trailing leaf (`Line` + `Fill` + rigid
`Text tone="muted"` — a real track, per the overlap rule in the `css` skill), and the menu gains
a **persistent footer** below the options, replacing the hint-only text:

> `tomorrow · next fri 3pm · jun 17 · 2026-06-17`

Shown in both the options and hint states — that is complaint (2)'s whole fix. Keep it one
`Text variant="caption" tone="muted"`; do not make it interactive.

### 3. Chip → picker — `web/components/date-mention-node.tsx`

Follow `plugins/page/plugins/math/plugins/inline/web/components/inline-math-node.tsx`
beat-for-beat — it is the working precedent for a click-to-edit decorator chip:

- Add writable setters `setIso(iso)` / `setReminderId(id | null)` (mirroring `setExpression`).
- `DateMentionView` wraps the existing `LinkChip` in an `InlinePopover` whose content is
  `<DatePickerPanel value={date} withTime={isReminder} />` plus a **Remind me** toggle and a
  **Remove** action.
- Commit via `lexicalEditor.update(() => { const n = $getNodeByKey(nodeKey); if ($isDateMentionNode(n)) n.setIso(iso); })`.
  The `nodeKey` must be threaded from `decorate()` into the view, as inline-math does.
- The Remind me toggle mints `crypto.randomUUID()` on and clears the id off. **No server work:**
  reminders are reconciled from block text on every `page.blocksChanged`
  (`server/internal/reconcile.ts`), so changing the token is the entire operation — this is the
  payoff of the existing text-driven design.
- Guard on `lexicalEditor.isEditable()`: a read-only render (history preview) shows the bare
  chip, no popover.

### 4. Drain the native date inputs

- **`plugins/fields/plugins/date/plugins/filter/web/components/date-filter.tsx`** (live UI —
  the anchor popover behind any date-column filter: Tasks → Created, Debug → Reports, Mail →
  Date, All conversations → Created/Ended). Replace *only* the "Exact date"
  `<input type="date">` inside `AnchorChooser` with `<Calendar value={fromISODay(exactIso)}
  onSelect={(d) => pick({ kind: "date", iso: toISODay(d) })} />`. The Relative presets and
  `RelativeAnchorBuilder` above it stay — they emit `{kind:"relative"}` anchors, which a
  calendar cannot express. This consumer is why `Calendar` is exported separately from
  `DatePickerPanel`.
- **`plugins/fields/plugins/date/plugins/inline/web/components/date-editor.tsx`** — swap the
  native input for a `DatePickerPopover` that opens on mount, commits on select, cancels on
  Esc/outside-press, and drop the local `toISODay` in favour of the primitive's (fixing the UTC
  off-by-one noted above). **Caveat: not reachable in the UI today** — every `type: "date"`
  field in the repo is read-only (none declares `onEdit`) and `custom-columns` v1 only authors
  `"text"`. It therefore lands verified by a jsdom test only; say so when reporting.

## Files

| Action | Path |
|---|---|
| new | `plugins/primitives/plugins/date-picker/{package.json,core/index.ts,core/internal/*.ts,web/index.ts,web/components/*.tsx}` |
| new | `plugins/primitives/plugins/date-picker/CLAUDE.md` (hand-written prose; the autogen block is filled by `./equin build`) |
| edit | `plugins/page/plugins/inline-date/web/internal/date-options.ts` (+ `.test.ts`) |
| edit | `plugins/page/plugins/inline-date/web/components/inline-date-plugin.tsx` |
| edit | `plugins/page/plugins/inline-date/web/components/date-mention-node.tsx` |
| edit | `plugins/fields/plugins/date/plugins/filter/web/components/date-filter.tsx` |
| edit | `plugins/fields/plugins/date/plugins/inline/web/components/date-editor.tsx` |

Registration is filesystem-derived — create the barrels and run `./equin build`; never
hand-edit `web.generated.ts`.

## Verification

1. `bun test plugins/primitives/plugins/date-picker/core` — day math: DST boundary, Jan→Feb→Mar
   `addMonths` rollover, `buildMonthGrid` always 6×7 and starts on `weekStartsOn`,
   `toISODay`/`fromISODay` round-trip in a negative-UTC-offset timezone (`TZ=America/Los_Angeles`),
   `relativeDayLabel` at local midnight edges.
2. `bun test plugins/page/plugins/inline-date/web/internal` — extend the existing suite: `@tod`
   yields a pressable `Today` row (not the empty hint state), `@today` labels the date row
   `Today` with a `Mon, Aug 3` detail and emits exactly one date row, `@john` still closes the
   menu.
3. `./equin build`, then at `http://att-1785751631-kpzq.localhost:9000/pages/page/block-1785751438858-0dmjod`:
   type `@tod` → `Today` highlighted, Enter inserts today's chip; type `@` → footer lists the
   formats; click the chip → calendar opens, pick another day → chip relabels; toggle **Remind
   me** → icon switches to the bell.
4. `mcp__singularity__query_db` on `page_reminders` to confirm the Remind-me toggle round-trips
   through the text reconciler (a row appears, and disappears when toggled off).
5. Tasks pane → filter on **Created** → *is* → the anchor popover's "Exact date" section now
   shows the calendar; picking a day filters correctly (`resolveAnchorDay` reads the same
   `yyyy-mm-dd`).
6. `./equin check` — `no-adhoc-layout` / `-spacing` / `-radius` / `-typography` /
   `-control` all clean on the new components, plus `plugins-doc-in-sync` and
   `plugin-boundaries`.

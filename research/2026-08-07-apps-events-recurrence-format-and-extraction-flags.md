# Events: a recurrence format that defines an event once, and a global extraction flag channel

## Context

The URL source type extracts events from a page with one Sonnet call. Today the prompt
(`plugins/apps/plugins/events/plugins/sources/plugins/url-extract/server/internal/prompt.ts`)
tells the model to **materialize** recurrence:

> emit ONE ROW PER CONCRETE OCCURRENCE within the next 60 days, all sharing a `seriesKey`

So "every Thursday" costs the model ~9 near-identical JSON objects. The user's complaint is
exactly that: the agent repeats the same event over and over. It is expensive, the repeated
copies drift from each other, and the format has no way to *say* "weekly" — the only
vocabulary is a list of dates.

Second gap: the extractor has no channel to report what it could not express. A page that
says "every 2nd and 4th Tuesday" either gets silently mangled into whatever the format can
hold, or dropped. Nothing surfaces.

Two changes, then:

1. **A date format that states recurrence once**, owned by a self-contained plugin — the
   user expects to keep customizing it, so the schema, the expander, the human label, the
   identity contribution and the prompt fragment that documents it to the model all live in
   one folder and move together.
2. **A global, per-extraction-session flag channel** — not per event — so the model can
   report limitations, surfaced on the run row, in the run pane, and on the source's Status
   card.

### Decisions taken

- **One row per series.** A recurring event is a single `events` row carrying the rule, not
  N materialized occurrences. Event rendering and filtering stay exactly as they are for
  now — this plan deliberately does not touch the event list, the keyset query, or the
  date filters.
- **Rich but closed rule vocabulary**: freq / interval / weekdays / month days /
  nth-weekday, with `until` or `count`. Anything beyond it is reported through the flag
  channel rather than approximated silently.
- **Flags surface in three places**: the runs list, the run detail pane, and the source
  Status section.

---

## 1. New plugin: `plugins/apps/plugins/events/plugins/event-date/`

Core-only (precedent: `plugins/framework/plugins/plugin-id`) — `package.json`, `CLAUDE.md`,
`core/index.ts`, and `core/internal/{event-date,expand,describe,identity,prompt-spec}.ts`
with `*.test.ts` beside them. It is a leaf: it imports `zod` and nothing from other plugins,
so `events-core` can depend on it without a cycle.

### The format

```ts
export const WEEKDAYS = ["mo","tu","we","th","fr","sa","su"] as const;
export const RECURRENCE_FREQS = ["daily","weekly","monthly","yearly"] as const;

RecurrenceRuleSchema = z.object({
  freq:       z.enum(RECURRENCE_FREQS),
  interval:   z.number().int().positive().default(1),
  byWeekday:  z.array(z.enum(WEEKDAYS)).optional(),
  byMonthDay: z.array(z.number().int().min(1).max(31)).optional(),
  nthWeekday: z.object({ nth: z.number().int().min(-1).max(5),
                         weekday: z.enum(WEEKDAYS) }).optional(),
  until:      z.coerce.date().optional(),
  count:      z.number().int().positive().optional(),
});

EventDateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"),
             startsAt: z.coerce.date(), endsAt: z.coerce.date().optional(),
             allDay: z.boolean().optional() }),
  z.object({ kind: z.literal("recurring"),
             startsAt: z.coerce.date(),          // anchor: the first/next occurrence
             endsAt: z.coerce.date().optional(), // end of THAT occurrence; carries the duration
             allDay: z.boolean().optional(),
             rule: RecurrenceRuleSchema,
             label: z.string().optional() }),    // the page's own words, when it has any
]);
```

Two arms, on purpose. An irregular published date list ("Aug 13, Aug 20, Sep 3") is *not* a
third arm — it is precisely the case the flag channel exists to report, and shipping the
flag channel without a case that exercises it would leave it untested by construction.

### The API the format owes its consumers

| Export | Why it exists |
|---|---|
| `expandEventDate(date, { from, until, max })` → `EventOccurrence[]` | Pure, deterministic. Not on the write path any more, but it *is* the meaning of the format — the read side (a calendar, "what's on Saturday") is unusable without it. `max` is a hard safety bound. |
| `nextOccurrence(date, from)` → `{ found: true; occurrence } \| { found: false; reason: "exhausted" }` | On the write path (see §4). A discriminated result, never `null` — an exhausted series is a legitimate answer, not an absorbable failure (`no-absorbed-failure`). |
| `describeEventDate(date)` → `string` | "every Thursday", "first Friday of the month" — used when the model supplies no `label`. |
| `eventDateIdentityKey(date)` → `string` | **The load-bearing one.** See §4. `once` → the UTC day key of `startsAt`; `recurring` → a canonical signature of the rule (`weekly:1:th:until=…`), *independent of the anchor*. |
| `eventDateProjection(date)` → `{ startsAt, endsAt, allDay, recurring, recurrenceLabel }` | The denormalized `events` columns, derived from the format in ONE place so they cannot drift from it. |
| `EVENT_DATE_PROMPT_SPEC` | The prompt fragment describing the format to the model. Lives here so spec, parser and expander cannot drift apart — the whole reason the user asked for a self-contained plugin. |

**Documented limitation (in the plugin's `CLAUDE.md`):** there is no timezone database.
`startsAt` is an instant carrying the page's offset; the expander advances in wall-clock days
from that instant, so a weekly 23:00 event crossing a DST boundary shifts by an hour on the
read side. One row per series is what keeps this out of storage entirely — the stored anchor
is always an exact published instant.

---

## 2. Contract changes in `events-core`

`core/internal/extracted-event.ts`:

- Drop `startsAt`, `endsAt`, `allDay`, `recurring`, `recurrenceLabel`, `seriesKey`.
- Add `date: EventDateSchema`.
- Add, in the same file or a sibling `extraction-result.ts`:

```ts
export const ExtractionResultSchema = z.object({
  events: ExtractedEventSchema.array(),
  /** Global to the parse session, never per event. Free text, one limitation each. */
  flags: z.array(z.string()).default([]),
});
```

`server/internal/registry.ts`: `extract(payload, ctx) -> Promise<ExtractionResult>` instead
of `Promise<ExtractedEvent[]>`. The doc comment's "`[]` means the page genuinely lists no
events, never a failure" invariant carries over verbatim to `events: []`.

**Flags are `string[]`, not `{ code, message }`.** The user's `{"flag": "reason"}` sketch is
one reason per entry; a `code` would have to be a closed vocabulary of *things the format
cannot express*, which is unknowable in advance — that is the whole point of the channel.
A structured shape can be added later without a wire break by widening the element type.

### Schema fields (`core/internal/fields.ts` + `server/internal/tables.ts`)

- `eventFields.date`: `jsonField<EventDate>({ schema: EventDateSchema, default: … })`, with
  no DB default (see the migration note in §7).
- `eventFields`: **drop `seriesKey`.** With one row per series the row *is* the series and
  its `externalId` is the series key; a second identifier for the same thing is a
  correctness hazard. `recurring` and `recurrenceLabel` stay — they are cheap denormalized
  projections of `date`, written via `eventDateProjection`, and keeping them is what lets
  the event list keep working untouched.
- `eventSourceRunFields.flags`: `jsonField<string[]>({ schema: z.array(z.string()), default: [] })`,
  plus `columns: { flags: { default: [] } }` in `defineEntity` — the wire default and the DDL
  default are distinct concepts and both are needed (`tags` on `eventFields` is the precedent).
- `eventSourceFields.lastFlags`: same shape. Derived runtime state on the source row, beside
  `lastError` / `lastFingerprint`, written atomically with the ledger row — which is what
  lets the Status card show it without a second query.

---

## 3. Prompt and parsing (`url-extract`)

`server/internal/prompt.ts`:

- Delete `EXTRACTION_HORIZON_DAYS` and rules 3 and 4 (the materialization instructions).
  Nothing replaces them — the model no longer projects dates forward at all.
- Interpolate `EVENT_DATE_PROMPT_SPEC` where the `startsAt`/`recurring` key docs are today.
- Change the response envelope from a bare array to
  `{"events": [...], "flags": ["…", …]}`, and state the flag rule explicitly: global to the
  whole page, one entry per limitation, only for schedules or event shapes the `date` format
  could not express — not a general commentary channel, and never a substitute for omitting
  an event whose date is undeterminable.

`server/internal/parse-response.ts`:

- `isolateJsonArray` → `isolateJsonObject`: the same string-aware brace scan, `{`/`}` instead
  of `[`/`]`. Keep the escape handling — a `}` inside a flag string must not end the object.
- Validate against `ExtractionResultSchema`.
- Every failure stays a `NonRetryableError` carrying a bounded raw excerpt, and the
  file-header invariant holds unchanged and is worth re-stating in the comment: a parse
  failure must never degrade to an empty result, because the engine reads that as "the page
  lists nothing" and stamps `disappearedAt` across the whole source.
- Do **not** accept a bare array as a fallback. One format; a stale response shape is a loud
  terminal failure.

`server/internal/extract.ts` returns the `ExtractionResult` through unchanged otherwise.

---

## 4. The engine (`refresh`)

**`server/internal/external-id.ts` — the critical change.** Identity is today
`sha256(sourceId + normalizedTitle + startsAt::date)`. For a series that is fatal: next
week's extraction reports a later anchor, which would derive a *different* identity, insert
a duplicate, and bury the original as disappeared. So:

```ts
deriveExternalId(sourceId, title, date) =
  sha256(sourceId + SEP + normalizeTitle(title) + SEP + eventDateIdentityKey(date))
```

For a `once` date `eventDateIdentityKey` returns the UTC day key — **byte-identical to
today's derivation**, so every existing one-off row keeps its identity and no duplicate
storm follows the deploy. For a `recurring` date it returns the rule signature, so a series
is one stable row however often the page is re-read and however far its anchor has moved.

**`server/internal/plan-writes.ts`**: one extracted event → exactly one `EventWriteInput`.
It takes the clock as a parameter (`planEventWrites(sourceId, extracted, { now })`) so it
stays pure and unit-testable, and it:

- writes `date` verbatim,
- fills `startsAt` / `endsAt` / `allDay` / `recurring` / `recurrenceLabel` from
  `eventDateProjection(date)`,
- **normalizes the anchor** via `nextOccurrence(date, now)`: a model that anchors "every
  Thursday" on a Tuesday, or on a date already past, is corrected deterministically instead
  of trusted. `{ found: false }` (an exhausted series — its `until` has passed) drops the
  event from the plan; that is a legitimate "this series is over", not a failure.

Everything else in the file is unchanged, including the rule that every optional not
supplied is written as an explicit `null`.

**`server/internal/run-source.ts`**: destructure `{ events, flags }` from `extract`, pass
`flags` to `finishExtracted`. No other phase moves.

**`server/internal/run-ledger.ts`**: `finishExtracted` writes `flags` on the run row *and*
`lastFlags` on the source row, inside the existing single transaction. `finishUnchanged` and
`finishFailed` write `flags: []` on their own run row and leave `lastFlags` alone — an
unchanged run did not re-read the page, so the last extraction's caveats still stand.

---

## 5. The manual source type

`server/internal/echo.ts`: `toExtractedEvent(row)` maps `date: row.date` and drops the six
removed keys. The `EchoIsLossless` compile-time proof needs **no structural change** — with
`date` present as both a column and an `ExtractedEvent` field, and `seriesKey` gone,
`Exclude<EchoedColumn, keyof ExtractedEvent>` is still `never`. The proof gets simpler, not
weaker; it still fires if a future `events` column cannot be carried.

`server/internal/source-type.ts`: `extract` returns `{ events: echoRows(...), flags: [] }`.
`MANUAL_FINGERPRINT` stays at `manual:v1` — there is nothing to re-import.

---

## 6. UI

1. **Runs list** — `.../source-detail/plugins/runs/web/components/runs-section.tsx`: add a
   field `{ id: "flags", label: "Caveats", type: "number", value: r => r.flags.length,
   align: "end" }`. Purely additive; `config/apps/events/sources/source-detail/runs/events.source-runs.jsonc`
   needs no edit (existing views keep working).
2. **Run row** — `run-row.tsx`: a `warning` Badge reading `⚠ N` when `flags.length > 0`,
   beside the outcome chip.
3. **Run detail** — new sub-plugin
   `.../source-detail/plugins/runs/plugins/caveats/`, a sibling of `model-call` and modelled
   on it byte-for-byte: `package.json`, `CLAUDE.md`, `web/index.ts` contributing
   `EventSourceRunDetail.Section({ id: "caveats", label: "Extraction caveats",
   icon: MdWarningAmber, component })`, and `web/components/caveats-section.tsx`. Fetches
   through `useEventSourceRun(runId)`. Always available (never hidden by `useAvailable`) —
   loading is not emptiness. Three explicit arms: error → `Placeholder tone="error"`,
   pending → `<Loading variant="rows" />`, empty → a `Placeholder` saying the extraction
   reported no limitations, which is the expected outcome and not a fault. Add its item key
   to `config/apps/events/sources/source-detail/runs/event-source-run-detail.section.jsonc`.
4. **Source Status card** — `.../source-detail/plugins/status/web/components/status-section.tsx`:
   a "Caveats" line reading `source.lastFlags`, labelled as being from the last extraction
   (not the last run) so an `unchanged` run does not make stale caveats look fresh.

---

## 7. Migration

One generated migration (`./equin build`; never `drizzle-kit generate` by hand):

- `event_source_runs.flags` and `event_sources.last_flags` — `jsonb NOT NULL DEFAULT '[]'`,
  a single `ADD COLUMN` each, no rewrite (precedent: `20260619_113639_fea32f87__slow_ops_waits.sql`).
- `events.series_key` — dropped.
- `events.date` — `jsonb NOT NULL` with **no usable constant default**, so it needs a
  backfill before the constraint: existing rows are all one-off, and
  `{"kind":"once","startsAt":<starts_at>,"endsAt":<ends_at>,"allDay":<all_day>}` is exactly
  true of every one of them. Read `plugins/database/plugins/migrations/CLAUDE.md` for the
  sanctioned data-migration-before-schema-change mechanism before writing this step.

**Expected one-time effect**: rows the *old* prompt materialized as individual occurrences
of a series are no longer listed by the next extraction, so that run stamps `disappearedAt`
on them. This is soft, correct, and self-resolving — the series they belonged to reappears
as a single row.

---

## 8. Verification

Unit (`bun:test`, beside source, `./equin test <path>`):

- `event-date`: expansion across month boundaries, `interval > 1`, `nthWeekday` including
  `nth: -1`, `until`/`count` termination, the `max` bound, an exhausted series through
  `nextOccurrence`, and — most important — `eventDateIdentityKey` **stability**: the same
  rule with different anchors must produce the same key, and a `once` key must still equal
  today's UTC day key.
- `plan-writes`: one event in → one row out; anchor normalization; an exhausted series
  dropped; the projection columns matching `date`.
- `parse-response`: the object envelope, flags round-tripping, a bare array now failing
  loudly, and a `}` inside a flag string not truncating the object.
- `external-id`: a `once` event's id unchanged from the current derivation (regression
  guard against the duplicate storm).

End to end:

1. `./equin build`, then `./equin check` (expect `migrations-in-sync`,
   `plugins-doc-in-sync`, `plugin-boundaries`, `type-check`, `eslint` to all pass; the
   CLAUDE.md autogen blocks are regenerated by the build, never hand-edited).
2. Add a URL source pointing at a venue page with a weekly night, Refresh now, and confirm
   in the UI: one row for the series with its label, a caveat count on the run row, the
   caveats section in the run pane, and the Status card line.
3. `query_db`: `select title, date, recurring, recurrence_label from events where source_id = …`
   and `select outcome, flags from event_source_runs order by started_at desc limit 5`.
4. Re-run Refresh now (after bumping the source's fingerprint) and confirm the series row is
   **updated, not duplicated** — the single most important behavioural assertion here.
5. The existing e2e scripts still pass: `plugins/apps/plugins/events/plugins/sources/e2e/sources-verify.ts`
   and `.../source-detail/plugins/runs/e2e/run-pane-verify.ts`.

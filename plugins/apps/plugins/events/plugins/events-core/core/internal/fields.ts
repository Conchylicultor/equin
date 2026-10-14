import { z } from "zod";
import { idKindField } from "@plugins/ids/core";
import { eventIdKind, eventRunIdKind, eventSourceIdKind } from "./id-kinds";
import { nullable, type FieldsRecord } from "@plugins/fields/core";
import {
  textField,
  enumTextField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { tagsField } from "@plugins/fields/plugins/tags/plugins/config/core";
import {
  EventDateSchema,
  type EventDate,
} from "@plugins/apps/plugins/events/plugins/event-date/core";
import {
  EVENT_CATEGORIES,
  EVENT_CATEGORY_META,
  REFRESH_CADENCES,
  RUN_EVENT_ACTIONS,
  RUN_OUTCOMES,
  RUN_OUTCOME_META,
  SOURCE_STATUSES,
} from "./vocab";

/**
 * The `date` field's wire default, and nothing more.
 *
 * `FieldDef` requires a `defaultValue`, but there is no honest constant for "when
 * does this happen" — so this one is deliberately unreachable rather than
 * plausible: the column carries NO DB default (see `server/internal/tables.ts`),
 * so every insert must state a date, and a row therefore never falls back to it.
 * The epoch is chosen because it is obviously wrong on sight; a "sensible" value
 * like `now` would let a future write that forgot `date` look correct.
 */
const UNREACHABLE_DATE_DEFAULT: EventDate = {
  kind: "once",
  startsAt: new Date(0),
};

// Web-safe field records for the Events app's three persisted tables — one
// `FieldsRecord` per table, the single source of truth for both the Drizzle
// pgTable (derived in `server/internal/tables.ts` via `defineEntity`) and the
// public wire schema (`fieldsToZodObject` in `./schema.ts`). A column/schema
// drift is therefore unrepresentable: `entity.table.$inferSelect ≡ z.infer<Schema>`.
//
// Keys are the JS property names (camelCase) IN COLUMN ORDER; the DB column name
// is `snakeCase(key)`. FK / cascade / index / default DDL is expressed in the
// `defineEntity` meta, NOT here — this file is name- and storage-agnostic.

/**
 * One configured source instance ("the Fitzroy page"), NOT a source *type*.
 *
 * Sources are rows rather than a config singleton because the user adds N
 * instances of the same type and `events` FK back to them. Runtime/derived state
 * (`status`, `lastFingerprint`, the run watermarks, the classified error) lives
 * here and never in `config` — the `mail_accounts` + `mail_sync_state` split.
 * `config` holds only the per-type user input, validated against the source
 * type's own `configFields`.
 */
export const eventSourceFields = {
  id: idKindField(eventSourceIdKind),
  /** The `EventSourceType.id` this row dispatches to (`url`, `manual`, …). */
  type: textField(),
  /** User label; defaulted from the URL host at create time. */
  name: textField(),
  /** Per-type user input, validated against the type's `configFields` on write. */
  config: jsonField<Record<string, unknown>>({
    schema: z.record(z.string(), z.unknown()),
    default: {},
  }),
  refresh: enumTextField(REFRESH_CADENCES),
  enabled: boolField(),
  status: enumTextField(SOURCE_STATUSES),
  /** The probe cache key. The engine calls `extract` ONLY when this moves. */
  lastFingerprint: nullable(textField()),
  lastRunAt: nullable(dateField()),
  /** Scheduler watermark — the cadence tick reads this, not a cron per source. */
  nextRunAt: nullable(dateField()),
  /** Classified TERMINAL failure only; a transient failure stays on the run row. */
  lastError: nullable(textField()),
  lastErrorCode: nullable(textField()),
  /**
   * What the LAST EXTRACTION could not express — copied off that run's `flags`,
   * atomically with the ledger row, so the Status card reads the source's caveats
   * without a second query.
   *
   * Derived runtime state like `lastFingerprint` / `lastError`, and specifically
   * the last *extraction*'s, not the last run's: an `unchanged` run never re-read
   * the page, so it leaves this alone rather than clearing caveats that still
   * stand.
   */
  lastFlags: jsonField<string[]>({ schema: z.array(z.string()), default: [] }),
  /**
   * How the LAST RUN ended — ANY run, including the cheap `unchanged` ones, so
   * this is the newest thing the engine knows rather than the newest thing it
   * re-read.
   *
   * Derived runtime state like `lastFingerprint`, written by the run ledger in
   * the same transaction as the run row it comes from. `null` means no run has
   * completed yet — a real state the sources list renders as "never run", NOT an
   * error and never to be defaulted into looking like one (hence no DB default
   * in `server/internal/tables.ts`).
   */
  lastOutcome: nullable(enumTextField(RUN_OUTCOMES)),
  /**
   * How many events the last EXTRACTION found — the count that answers "is this
   * source still working?", which is why it is worth denormalizing off the run
   * ledger at all.
   *
   * Same rule as `lastFlags`, for the same reason: only an `extracted` run
   * writes it. An `unchanged` run never re-read the page and a `failed` one
   * never got there, so clearing or zeroing it on those runs would replace a
   * true count with a lie. `null` until the first extraction.
   */
  lastEventCount: nullable(intField()),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

/**
 * The domain table.
 *
 * Two timestamp pairs on purpose, because they answer different questions:
 * `createdAt`/`updatedAt` are ROW lifecycle (`updatedAt` moves on any change to
 * a visible column, derived in the DB — the revision tick reads it), while
 * `firstSeenAt`/`lastSeenAt`/`disappearedAt` are EXTRACTION sighting (when the
 * source last vouched for this event). Disappearance is soft: an event absent
 * from a successful full extraction gets `disappearedAt` stamped, never deleted,
 * so a flaky scrape cannot destroy rows the user may have annotated.
 */
export const eventFields = {
  id: idKindField(eventIdKind),
  sourceId: textField({ label: "Source" }),
  /**
   * Dedup identity, unique per `(sourceId, externalId)`. A source type MAY
   * supply it; when it can't (an LLM extraction can't), the ENGINE derives
   * `sha256(sourceId + normalizedTitle + eventDateIdentityKey(date))`. Deriving
   * it in the engine rather than per-type is what keeps re-extraction idempotent
   * by construction — never make this nullable.
   *
   * With one row per series, this IS the series key: a recurring event keeps one
   * identity however far its anchor moves, because the identity key of a
   * `recurring` date is the rule signature, not the anchor.
   */
  externalId: textField(),
  title: textField({ label: "Title", primary: true }),
  description: nullable(textField({ label: "Description" })),
  /**
   * When it happens, stated ONCE — a single instant, or a whole series with its
   * recurrence rule. The AUTHORITY on time for this row.
   *
   * Five columns are denormalized projections of it (`startsAt`, `endsAt`,
   * `allDay` here; `recurring`, `recurrenceLabel` below), written only through
   * `eventDateProjection` — never hand-set, never a second place to state the
   * fact. They exist so the event list, its keyset query and its date filters
   * keep working on plain indexed columns instead of digging into jsonb.
   *
   * The three OCCURRENCE ones (`startsAt`, `endsAt`, `allDay`) answer "when is
   * the next one" and so are true only of the instant they were written at;
   * `apps/events/reanchor` keeps them current. The two SERIES ones
   * (`recurring`, `recurrenceLabel`) restate the rule and never decay.
   *
   * NOT NULL with no DB default (`server/internal/tables.ts` gives it none):
   * there is no honest constant for "when", so a row without a date must be
   * unrepresentable rather than silently epoch-dated.
   */
  date: jsonField<EventDate>({
    schema: EventDateSchema,
    default: UNREACHABLE_DATE_DEFAULT,
  }),
  /**
   * Projection of `date`: for a series, the NEXT occurrence's anchor.
   *
   * That is a claim about NOW, so unlike the other four projections this one
   * expires — the moment the occurrence it names passes, the column is a lie
   * and every "upcoming" filter (`startsAt >= today`) drops a series that is
   * still running. It is therefore maintained derived state, and the
   * `apps/events/reanchor` plugin is its maintainer: it rolls this column (with
   * `endsAt` / `allDay`) forward from `date` on a schedule and at boot, so
   * correctness does not depend on the source being re-extracted.
   */
  startsAt: dateField({ label: "When" }),
  endsAt: nullable(dateField()),
  allDay: boolField(),
  venue: nullable(textField({ label: "Venue" })),
  city: nullable(textField({ label: "City" })),
  url: nullable(textField({ label: "Link" })),
  imageUrl: nullable(textField()),
  /** Free text ("Free", "12–18 €") — venues do not publish a normalizable number. */
  price: nullable(textField({ label: "Price" })),
  category: enumTextField(EVENT_CATEGORIES, {
    label: "Category",
    options: EVENT_CATEGORY_META,
  }),
  // `tagsField`, NOT `stringListField`: the `string-list` field type has no
  // `Fields.Storage` contribution, so `defineEntity` cannot map it to a column
  // (it is a config-only type). A tags column is the `jsonb` string array this
  // always was; its type is what lists filter it by (has any / all / none of).
  // An open vocabulary: no suggested options.
  tags: tagsField({ label: "Tags" }),
  /** Projection of `date`: true iff its `kind` is `recurring`. */
  recurring: boolField({ label: "Recurring" }),
  /** Projection of `date`: the series' human label ("every Thursday"). */
  recurrenceLabel: nullable(textField()),
  // No `seriesKey`: with one row per series the ROW is the series, and its
  // `externalId` is the key. A second identifier for the same thing is a
  // correctness hazard — two ids for one concept drift, and the one the upsert
  // does not use wins nothing.
  firstSeenAt: dateField(),
  lastSeenAt: dateField(),
  disappearedAt: nullable(dateField({ label: "Disappeared" })),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

/**
 * The run ledger — what makes "why did nothing happen" answerable. One row per
 * `runSource` invocation, including the cheap `unchanged` ones.
 */
export const eventSourceRunFields = {
  id: idKindField(eventRunIdKind),
  sourceId: textField({ label: "Source" }),
  startedAt: dateField({ label: "Started", primary: true }),
  finishedAt: nullable(dateField()),
  outcome: enumTextField(RUN_OUTCOMES, {
    label: "Outcome",
    options: RUN_OUTCOME_META,
  }),
  eventsFound: intField({ label: "Found" }),
  eventsCreated: intField({ label: "New" }),
  eventsUpdated: intField({ label: "Updated" }),
  eventsDisappeared: intField({ label: "Gone" }),
  /** The fingerprint this run observed (null when the probe cannot fingerprint). */
  fingerprint: nullable(textField()),
  durationMs: nullable(intField({ label: "Duration" })),
  error: nullable(textField({ label: "Error" })),
  /**
   * What the extractor could not express, one free-text entry per limitation —
   * global to the run, never per event.
   *
   * Empty is the expected outcome and never a fault; a non-empty list is a
   * successful run reporting a schedule or event shape the `date` format could
   * not hold. Distinct from `error`, which is a run that FAILED. Only an
   * `extracted` run can populate this: `unchanged` and `failed` runs write `[]`
   * because neither of them read the page.
   */
  flags: jsonField<string[]>({ schema: z.array(z.string()), default: [] }),
} satisfies FieldsRecord;

/**
 * Which events one run touched, and how — the per-event detail behind the run
 * row's `eventsCreated` / `eventsUpdated` / `eventsDisappeared` counts.
 *
 * A junction table rather than a `lastRunId` stamp on `events`, and the
 * distinction is the whole point: a stamp is overwritten by the NEXT run, so
 * every run but the newest would show an empty list under counts that say it
 * touched twelve events — a ledger contradicting itself. The same objection
 * rules out recovering the set from `lastSeenAt` windows. One row per (run,
 * event) is the only shape where a run keeps its own answer for as long as the
 * run row exists.
 *
 * Written ONLY by the engine, inside the same transaction as the run row (see
 * `refresh`'s run-ledger), so a run and its event list can never half-exist.
 * Reclaimed by the run's own 30-day retention through FK cascade — the rows
 * outlive nothing they explain.
 */
export const eventSourceRunEventFields = {
  runId: idKindField(eventRunIdKind),
  eventId: textField(),
  action: enumTextField(RUN_EVENT_ACTIONS),
} satisfies FieldsRecord;

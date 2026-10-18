# events-core

The Events app's contract layer. Everything else in the app depends on this and
nothing here depends on them.

## `EventSourceType` — two phases, on purpose

`defineEventSourceType` (server) registers a source *type* into an id-keyed
`Map` (the `defineWallpaperProvider` / `defineTrashSource` idiom) because the
refresh engine dispatches **by id** at run time — a source row names its type.

The `probe` / `extract` split makes the extraction cache **structural**: the
engine holds `lastFingerprint`, so it is literally unable to call the expensive
phase on an unchanged source. A single `run()` would leave "don't pay for the
LLM when nothing changed" as per-provider discipline a future marketplace source
type silently forgets — at real cost, on every tick, invisibly. `payload`
threads the already-fetched bytes from probe into extract, so the split costs no
second fetch. A type that genuinely cannot probe cheaply returns
`fingerprint: null` and always extracts.

`probe`/`extract` **throw**; `NonRetryableError` is terminal and classifies onto
the source row. `extract` returns `{ events, flags }`: `events: []` means the page
genuinely lists no events — never use it to signal a failure, or the engine will
stamp `disappearedAt` on everything it previously found. `flags` is a *report* on
a successful run (what the `date` format could not express), never a soft failure
and never a reason to keep an event whose date is undeterminable.

`ProbeContext` carries `runId` — the run the phase belongs to, minted by the
engine before the first phase. Stamp any durable side effect (a model call, a
fetched artifact) with it so the run's ledger row can find it afterwards. Generic
by construction: it names no LLM.

## Per-type config

A source type declares its user input as a `FieldsRecord` in its own `core/`.
The server validates a row's `config` jsonb against `fieldsToZodObject(...)`;
the web renders the add/configure form generically from the same record via the
`EventSources.Type` slot. **A new source type therefore ships zero form code.**

A type also answers "which page does a configured source of mine stand for?" via
the optional web-slot `originUrl(config)`, read back through
`useEventSourceOrigin()`. It takes a `SourceRef` (`{ type, config }`) and needs
nothing but the registry: the Sources list passes its row, and an events list
passes the ref the server joined onto each event row (`SourcedEvent`, whose flat
`sourceType` / `sourceConfig` `sourceRefOf` reads back — the `events.list`
collection's and the `events.run-events` value's rows), so no caller ever looks a `sourceId` up
in the sources set. Either way a surface names no source type. Omit
`originUrl` for a type that stands for no page (`manual`).

Both gate the answer through `externalUrl` at the mint: a type reads its URL out
of a free-text config field, so what it returns is untrusted, and gating it once
here means no consumer has to remember to. `externalUrl` lives in `core/` for the
same reason — it is the app's one "may this string be a destination or a `src`"
rule, and a second copy in a second plugin is a security guard with two spellings
to keep in step.

## Data model

Four `defineEntity` tables, field records in `core/internal/fields.ts`:

- `event_sources` — one row per *configured instance*. Runtime/derived state
  (`status`, `lastFingerprint`, `lastRunAt`/`nextRunAt`, the classified error,
  `last_outcome`/`last_event_count`) lives here, never in `config` — the
  `mail_accounts` + `mail_sync_state` split. `extractionStatus(source)` (`core/`)
  derives never/ok/empty/failed from the last two and is **never stored**: one
  fact, one derivation, nothing to drift. `empty` is its own arm on purpose — a
  successful extraction that found nothing is how a source goes silently broken,
  and folding it into `ok` is what hides it. `sourceState(source)` sits beside
  it and adds the two facts that outrank a past verdict — `disabled` >
  `running` > the extraction status — so a surface asks one question and gets
  one word.
- `events` — one row per event *or series*: `date` (jsonb, `event-date`) states
  recurrence once, and `starts_at`/`ends_at`/`all_day`/`recurring`/
  `recurrence_label` are its projections, written only via `eventDateProjection`.
  The three OCCURRENCE ones answer "when is the next one", so they expire when
  that occurrence passes: `apps/events/reanchor` re-derives them hourly and at
  boot. Don't drop it — without a maintainer a still-running series falls out of
  every `starts_at >= today` view as soon as its source stops being re-extracted.
  There is no `series_key`: the row IS the series and its `external_id` is the
  key. `date` is NOT NULL with **no** DB default — there is no honest constant
  for "when", so a write that omits it must fail loudly.
  Unique `(source_id, external_id)`; the engine upserts against it,
  which is why `external_id` is NOT NULL (a nullable column makes the conflict
  target unusable). A source type MAY supply an `externalId`; when it can't, the
  **engine** derives one — deriving it there is what keeps re-extraction
  idempotent by construction. Disappearance is soft (`disappeared_at` stamped,
  never deleted) so a flaky scrape can't destroy annotated rows. Two timestamp
  pairs: `created_at`/`updated_at` are row lifecycle, `first_seen_at`/
  `last_seen_at`/`disappeared_at` are extraction sighting.
- `event_source_runs` — the run ledger, including the cheap `unchanged` runs.
  This is what makes "why did nothing happen" answerable. Served as the live
  `events.source-runs` collection (`eventSourceRuns`): a scrollable window the
  source pane scopes to one source (`.scoped({ where: { sourceId } })`), its
  `columnScope` the runs DataView (whose custom columns sort and filter it), and
  a `:rows` point sibling. The change feed routes each run row's write to the
  tuples holding it, so the ledger and the live source status — written in one
  transaction — never disagree. One run is `useEventSourceRun(runId)` →
  `useLiveRow`: by its own id, deliberately NOT through the source, so a
  deep-linked run pane resolves from the URL instead of whatever window the runs
  list happens to have loaded. `flags` rides on the wire but is display-only.
- `event_source_run_events` — which events one run touched and how
  (`created`/`updated`/`disappeared`), the detail behind the run row's counts.
  Written by the engine INSIDE the ledger's own transaction, so a run and its
  event list cannot half-exist. Deliberately not a `last_run_id` stamp on
  `events`: a stamp is overwritten by the next run, leaving every older run
  showing an empty list under counts that say otherwise. Read live as the
  `runEvents` value (`events.run-events`, params `runId`, served `db`, at most
  `RUN_EVENTS_LIMIT`; the event row + its action, flat) through
  `useRunEvents(runId)`; an unknown run is refused `missing`, never `[]`.

**All `events` writes go through the repo funnel**, `upsertEvents()` /
`markEventsDisappeared()` / `reanchorRecurringEvents()` in
`server/internal/events-repo.ts`. The funnel owns the sighting stamps
(`first_seen_at`/`last_seen_at`) and soft disappearance; the barrel exports
`events` only as the read handle `eventsTable`,
and the plugin's own `events/no-raw-events-write` lint rule fails any
`db.insert/update/delete(eventsTable)` elsewhere. Don't add a second write path.

**`updated_at` is derived, never written.** Both `events` and `event_sources`
declare `touchedBy` in `server/internal/tables.ts`; a DB trigger bumps
`updated_at` only on a real change to a counted column and raises on any write
to it. On `events` every list-visible column counts and the sighting stamps do
not. On `event_sources` only the user's configuration (name, config, refresh,
enabled) counts, never the run bookkeeping.

The events LIST is not this plugin's: it is `event-list`'s `events.list` live
collection, kept fresh by the routed change feed (there is no `events.revision`
tick any more). What this plugin gives it is `SourcedEvent` — a `ListedEvent`
(the event row without its sighting stamps, so a content-identical re-extraction
moves no listed row) plus its source's `sourceType` / `sourceConfig`
(`sourceRefOf` reads the ref back) — and the read handles it joins.

Retention (`events` disappeared > 90 d, runs > 30 d) belongs to the `refresh`
plugin, which owns the sweeps.

## Refresh dispatch seam

`refresh` imports `events-core`, so `events-core` cannot import it back. The
"Refresh now" endpoint dispatches through `registerRefreshRunner` — a single
handler the engine installs in its `register` phase. Absent handler is a loud
503, not a swallowed no-op.

"Refresh all" (`POST /api/events/sources/refresh-all`) is that same seam in a
sequential loop over the ENABLED sources, answering a **tally** of the per-source
result arms — a disabled source is no candidate and is counted nowhere, and a
resolved promise is not "all refreshed".

Design: [`research/2026-08-03-apps-events-event-tracking-app.md`](../../../../../../research/2026-08-03-apps-events-event-tracking-app.md).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Contract layer for the Events app, web half: the EventSources.Type source-type slot plus the live sources / run hooks and the source-CRUD mutations. Contract layer for the Events app: the event_sources / events / event_source_runs entities, the defineEventSourceType two-phase registry, source CRUD endpoints, and the live sources and run-ledger collections.
- Web:
  - Slots: `EventSources.Type`
  - Slot contributors:
    - `EventSources.Type` ← `apps.events.sources.coworkmeet`
    - `EventSources.Type` ← `apps.events.sources.dmda`
    - `EventSources.Type` ← `apps.events.sources.manual`
    - `EventSources.Type` ← `apps.events.sources.salsanueva`
    - `EventSources.Type` ← `apps.events.sources.url-extract`
  - Contributes:
    - `IdKinds.Kind` "evrun"
    - `IdKinds.Kind` "evs"
    - `IdKinds.Kind` "evt"
  - Uses:
    - `ids.IdKinds`
    - `infra/endpoints.useEndpointMutation`
    - `network/live.LiveRowResult`
    - `network/live.useLive`
    - `network/live.useLiveRow`
    - `primitives/live-state.ResourceResult`
  - Exports (values):
    - `EventSources`
    - `useCreateEventSource`
    - `useDeleteEventSource`
    - `useEventSourceOrigin`
    - `useEventSourceRow`
    - `useEventSourceRun`
    - `useEventSources`
    - `useRefreshAllEventSources`
    - `useRefreshEventSourceNow`
    - `useRunEvents`
    - `useUpdateEventSource`
- Server:
  - Contributes:
    - `ids.kind` "evrun"
    - `ids.kind` "evs"
    - `ids.kind` "evt"
    - `taskCategory` "events"
    - `resource.declare` "events.run-events"
    - `resource.declare` "events.source-runs"
    - `resource.declare` "events.source-runs:groups"
    - `resource.declare` "events.source-runs:rows"
    - `resource.declare` "events.sources.all"
    - `resource.declare` "events.sources.all:rows"
  - Uses:
    - `database.db`
    - `ids.IdKinds`
    - `infra/endpoints.HttpError`
    - `infra/endpoints.implement`
    - `infra/entities.defaultNow`
    - `infra/entities.defineEntity`
    - `network/live.serveCollection`
    - `network/live.serveValue`
    - `tasks/task-category.TaskCategory`
  - DB schema: `plugins/apps/plugins/events/plugins/events-core/server/internal/tables.ts`
  - Exports (types):
    - `EventSourceType`
    - `EventWriteInput`
    - `ProbeContext`
    - `ProbeResult`
    - `ReanchorResult`
    - `RefreshRunner`
    - `TouchedEvent`
    - `UpsertEventsResult`
  - Exports (values):
    - `_eventSourceRunEvents`
    - `_eventSourceRuns`
    - `_eventSources`
    - `createSource`
    - `defineEventSourceType`
    - `deleteSource`
    - `eventSourcesServed`
    - `eventsTable`
    - `getEventSourceType`
    - `listEventSourceTypes`
    - `listRunEvents`
    - `listSources`
    - `markEventsDisappeared`
    - `reanchorRecurringEvents`
    - `registerRefreshRunner`
    - `requireRun`
    - `requireSource`
    - `updateSource`
    - `upsertEvents`
  - Resources:
    - `events.run-events` (push, unbounded: one run's closed event set — a single extraction, tens of events — and the loader caps it at RUN_EVENTS_LIMIT rows)
    - `events.source-runs` (keyed, window)
    - `events.source-runs:groups` (push)
    - `events.source-runs:rows` (keyed, point)
    - `events.sources.all` (keyed)
    - `events.sources.all:rows` (keyed, point)
  - Routes:
    - `GET /api/events/sources`
    - `POST /api/events/sources`
    - `GET /api/events/sources/:id`
    - `PATCH /api/events/sources/:id`
    - `DELETE /api/events/sources/:id`
    - `POST /api/events/sources/:id/refresh`
    - `POST /api/events/sources/refresh-all`
- Core:
  - Uses:
    - `apps/events/event-date.EventDate`
    - `apps/events/event-date.EventDateSchema`
    - `fields.FieldsRecord`
    - `fields.fieldsToZodObject`
    - `fields.nullable`
    - `fields/bool/config.boolField`
    - `fields/date/config.dateField`
    - `fields/int/config.intField`
    - `fields/json/config.jsonField`
    - `fields/tags/config.tagsField`
    - `fields/text/config.enumTextField`
    - `fields/text/config.textField`
    - `ids.defineIdKind`
    - `ids.idKindField`
    - `ids.IdOf`
    - `infra/endpoints.defineEndpoint`
    - `infra/entities.entityRef`
    - `network/live.liveCollection`
    - `network/live.LiveRowsCollection`
    - `network/live.liveValue`
  - Exports (types):
    - `CreateEventSourceBody`
    - `EventCategory`
    - `EventId`
    - `EventRecord`
    - `EventRunId`
    - `EventSource`
    - `EventSourceId`
    - `EventSourceRun`
    - `EventSourceRunEvent`
    - `EventSourceRunRow`
    - `ExtractedEvent`
    - `ExtractionResult`
    - `ExtractionStatus`
    - `ListedEvent`
    - `RefreshAllResult`
    - `RefreshCadence`
    - `RefreshSourceResult`
    - `RunEvent`
    - `RunEventAction`
    - `RunOutcome`
    - `SourcedEvent`
    - `SourceRef`
    - `SourceState`
    - `SourceStatus`
    - `UpdateEventSourceBody`
  - Exports (values):
    - `createEventSource`
    - `CreateEventSourceBodySchema`
    - `deleteEventSource`
    - `EVENT_CATEGORIES`
    - `EVENT_CATEGORY_META`
    - `eventFields`
    - `eventIdKind`
    - `eventRunIdKind`
    - `EVENTS_CATEGORY_ID`
    - `EventSchema`
    - `eventsEntityRef`
    - `eventSourceFields`
    - `eventSourceIdKind`
    - `eventSourceRunEventFields`
    - `EventSourceRunEventSchema`
    - `eventSourceRunFields`
    - `eventSourceRuns`
    - `EventSourceRunSchema`
    - `eventSourceRunsEntityRef`
    - `eventSources`
    - `EventSourceSchema`
    - `eventSourcesEntityRef`
    - `externalUrl`
    - `ExtractedEventSchema`
    - `EXTRACTION_STATUSES`
    - `ExtractionResultSchema`
    - `extractionStatus`
    - `getEventSource`
    - `listEventSources`
    - `REFRESH_CADENCE_META`
    - `REFRESH_CADENCES`
    - `refreshAllEventSources`
    - `RefreshAllResultSchema`
    - `refreshEventSourceNow`
    - `RefreshSourceResultSchema`
    - `RUN_EVENT_ACTIONS`
    - `RUN_EVENTS_LIMIT`
    - `RUN_OUTCOME_META`
    - `RUN_OUTCOMES`
    - `runEvents`
    - `RunEventSchema`
    - `SOURCE_STATES`
    - `SOURCE_STATUS_META`
    - `SOURCE_STATUSES`
    - `SourcedEventSchema`
    - `sourceRefOf`
    - `SourceRefSchema`
    - `sourceState`
    - `updateEventSource`
    - `UpdateEventSourceBodySchema`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by:
    - `active-data/event-source`
    - `apps/events/event-list`
    - `apps/events/reanchor`
    - `apps/events/refresh`
    - `apps/events/sources`
    - `apps/events/sources/coworkmeet`
    - `apps/events/sources/dmda`
    - `apps/events/sources/manual`
    - `apps/events/sources/refresh-all`
    - `apps/events/sources/salsanueva`
    - `apps/events/sources/source-detail/runs`
    - `apps/events/sources/source-detail/runs/caveats`
    - `apps/events/sources/source-detail/runs/extracted-events`
    - `apps/events/sources/source-detail/runs/model-call`
    - `apps/events/sources/source-detail/schedule`
    - `apps/events/sources/source-detail/settings`
    - `apps/events/sources/url-extract`
- Exemptions:
  - Exempts itself from: `events/no-raw-events-write` — `server/internal/events-repo.ts` (sanctioned)
  - Exempted by: `apps/events/events-core` (0 debt)

<!-- AUTOGENERATED:END -->

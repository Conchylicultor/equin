# Events app — vision & architecture

**Status:** design. This doc freezes the vision, the load-bearing abstraction, and the
contracts; the implementation is delegated to sub-agents per the workstream table at the end.

## Context

There is no surface in Singularity for *"what is happening, and when"*. The information
exists — on venue pages, in ticketing apps (Shotgun), in group platforms (Meetup), in
email — but each lives behind its own reader, in its own vocabulary, and none of them
answer the only question that matters: **what should I go to.**

The goal is one events database fed by pluggable **sources**, surfaced as a DataView the
user can slice into their own saved views (by category, by city, by month), and later by a
calendar view. The interesting technical claim is that *the extractor need not be a
per-site scraper*: a Sonnet one-shot reading a page's visible text turns an arbitrary
venue URL into structured events, which makes "add a source" a paste-a-URL gesture rather
than a coding task.

This is also a deliberate exercise of the platform thesis: a source type is a plugin, and
the marketplace end-state is users publishing source types (Songkick, Luma, Dice, a
university's events page) that drop into everyone else's Events app with zero edits to it.

## The end-user experience (written first, on purpose)

1. User opens **Events** in the app rail. The main surface is a DataView of upcoming
   events — title, date, category, venue, city, price — with the usual search / filter /
   sort / group chrome, and their own saved views in the switcher (`Upcoming`, `This
   weekend`, `Techno`, `Free`).
2. Sidebar → **Sources** → `+` → picks **Web page**, pastes
   `https://www.fitzroy-paris.com/soirees-a-theme-et-evenements-festifs`, picks a refresh
   cadence (`Manual` / `Daily` / `Weekly`), hits Save.
3. The source pane immediately shows a run: `Fetched 41 KB · extracted 12 events · 3.4 s`.
   The 12 events are in the DataView.
4. Next daily tick, the page is unchanged → the run row reads `Unchanged — skipped
   extraction`, and **no model call was paid for**. The Thursday after, the venue posts a
   new party → the fingerprint moves, Sonnet runs, one new event appears.
5. Later the user adds **Shotgun**, pastes an API key into the source's own form, and the
   same DataView now merges both — the `Source` field becomes another filter dimension.

Everything below exists to make exactly that sequence true.

## Architecture at a glance

New top-level app (per the `create-app` skill: the top-level plugin is an **empty**
namespace; all content lives in sub-plugins).

```
plugins/apps/plugins/events/                       # empty namespace plugin
  plugins/
    shell/            # Apps.App entry, Events.Sidebar slot, layout, landing pane
    events-core/      # THE contract layer: fields, tables, source-type registry,
                      #   endpoints, live resources.  Everything depends on this.
    refresh/          # the engine: cron tick, per-source refresh job, upsert/diff, run ledger
    event-list/       # the events DataView pane (server-delegated query)
    event-detail/     # per-event detail pane (detail-sections host)
    sources/          # sidebar entry, source list, add/configure side-pane
      plugins/
        url-extract/  # source type: fetch page → fingerprint → Sonnet extraction
        manual/       # source type: hand-typed events
        # follow-ups, same shape, zero engine edits:
        # shotgun/  meetup/  email/  ical/
```

Naming discipline — **one name per concept**, used everywhere:

- **source** — a *configured instance*, a row in `event_sources` ("the Fitzroy page").
- **source type** — the *plugin* that knows how to read that kind of thing (`url`,
  `manual`, `shotgun`). Never call this a "source".

(The web-side slot namespace is `EventSources`, plural — `EventSource` is a DOM global and
must not be shadowed.)

## The load-bearing abstraction: `EventSourceType`

This is the one decision worth getting right; everything else is plumbing.

A source type is registered on the server with the **id-keyed `Map` + `Registration`**
idiom already used three times in the repo — copy
`plugins/apps-core/plugins/surface/plugins/floating/plugins/wallpaper/server/internal/registry.ts`
(twins: `infra/trash` `defineTrashSource`, `history/engine` `defineHistorySource`). That
idiom, not `defineServerContribution`, because the engine dispatches **by id** at run time
(a source row names its type) rather than running every contributor — `backup`'s
`defineServerContribution` is the right tool only for the run-them-all case.

```ts
// plugins/apps/plugins/events/plugins/events-core/server/internal/registry.ts
export interface EventSourceType<TConfig = unknown, TPayload = unknown> {
  id: string;                       // "url" | "manual" | "shotgun" — matches core/
  /** Cheap. Fetch raw material and fingerprint it. No LLM, no parsing, no writes. */
  probe(ctx: ProbeContext<TConfig>): Promise<{
    fingerprint: string | null;     // null = "cannot fingerprint, always extract"
    payload: TPayload;
  }>;
  /** Expensive. Only ever called when the fingerprint moved. */
  extract(payload: TPayload, ctx: ProbeContext<TConfig>): Promise<ExtractedEvent[]>;
}

export function defineEventSourceType<C, P>(t: EventSourceType<C, P>): EventSourceType<C, P> & Registration
export function getEventSourceType(id: string): EventSourceType | undefined
```

**Why two phases instead of one `run()` that returns `{ unchanged } | { events }`.**
The split makes the cache *structural*: the engine holds `lastFingerprint`, so it is
literally unable to call `extract` on an unchanged source. A single `run()` would leave
"don't pay for the LLM when nothing changed" as per-provider discipline that a future
marketplace source type silently forgets. `payload` threads the already-fetched bytes from
probe into extract, so the split costs no second fetch. A source that genuinely cannot
probe cheaply (a paginated API where probing *is* fetching) returns `fingerprint: null`
and always extracts — an honest declaration, not a workaround.

**Failure is a type, never an absorbable value** (root `CLAUDE.md`). `probe`/`extract`
**throw**: a plain throw is transient (graphile retries, `maxAttempts: 3`);
`NonRetryableError` (from `@plugins/infra/plugins/jobs/server`) is terminal and gets
classified onto the source row's `status: "error"` + `lastError`, mirroring mail-sync's
`classify-error.ts` / `record-error.ts` pair. A source type never returns `[]` to mean
"it broke" — an empty array means the page genuinely lists no events.

### Per-type config is a `FieldsRecord`, declared once in `core/`

```ts
// plugins/apps/plugins/events/plugins/sources/plugins/url-extract/core/index.ts
export const URL_SOURCE_TYPE_ID = "url";
export const urlSourceConfigFields = {
  url: textField({ label: "Page URL" }),
  hint: nullable(textField({ label: "Extraction hint", description: "e.g. 'only the club nights, ignore private hire'" })),
} satisfies FieldsRecord;
```

Because it lives in `core/` it is web-safe *and* server-usable, so:

- the **server** validates a source row's `config` jsonb against `fieldsToZodObject(...)`,
- the **web** renders the add/configure form generically via `FieldRenderer` — the same
  machinery `config_v2` uses.

**A new source type therefore ships zero form code.** That is the payoff: `shotgun/` is a
`core/` field record (`apiKey: secretField()`, `city: textField()`) plus a `server/`
`defineEventSourceType`, and it appears in the `+` menu with a working form. API keys use
`secretField()` from `@plugins/fields/plugins/secret/plugins/config/core` (AES-256-GCM via
`infra/secrets`, no data-view cell so it can never leak into a table) — **not**
`Auth.Provider`, which is the heavyweight OAuth-account-with-an-identity path and is wrong
for a pasted key. A type that needs bespoke chrome (a Meetup "Connect" button) may also
contribute an optional custom section; the generic form stays the default.

The matching **web** registration is the wallpaper `Wallpaper.Provider` slot, renamed:

```ts
// events-core/web/slots.ts
export const EventSources = {
  Type: defineSlot<{
    id: string; label: string; icon?: IconType;
    configFields: FieldsRecord;
    Extra?: ComponentType<{ sourceId: string }>;   // optional bespoke chrome
  }>("events.source-type", { docLabel: (p) => p.label }),
};
```

Two independent one-way imports (sub-plugin web → `events-core/web`, sub-plugin server →
`events-core/server`), never web↔server inside the sub-plugin — exactly the openverse
wiring.

## Data model

Three tables in `events-core`, via `defineEntity` (field records in
`core/internal/fields.ts`, entities in `server/internal/tables.ts`, per the `mail-core`
layout — that file must stay a synchronously-requireable leaf).

**`event_sources`** — one row per configured source.

| column | field | note |
|---|---|---|
| `id` | `textField()` | pk |
| `type` | `textField()` | the `EventSourceType.id` |
| `name` | `textField()` | user label, defaulted from the URL host |
| `config` | `jsonField({ schema: z.record(z.unknown()), default: {} })` | validated per-type |
| `refresh` | `enumTextField(REFRESH_CADENCES)` | `manual\|hourly\|daily\|weekly` |
| `enabled` | `boolField()` | |
| `status` | `enumTextField(SOURCE_STATUSES)` | `idle\|running\|error` |
| `lastFingerprint` | `nullable(textField())` | the cache key |
| `lastRunAt` / `nextRunAt` | `nullable(dateField())` | scheduler watermark |
| `lastError` / `lastErrorCode` | `nullable(textField())` | classified, terminal only |

Runtime/derived state lives here, **not** in config — the `mail_accounts` +
`mail_sync_state` split. `config_v2` is used only for genuinely global knobs
(`events` config: scheduler enabled, model tier, extraction horizon days).

Sources are **rows, not a config singleton**, because the user adds N instances of the
same type (three scrape URLs, two Meetup groups) and events FK back to them — the one
shape none of the existing registry precedents cover.

**`events`** — the domain table. `sourceId` FK → `event_sources` `onDelete: cascade`.

`id`, `sourceId`, `externalId`, `title`, `description?`, `startsAt`, `endsAt?`, `allDay`,
`venue?`, `city?`, `url?`, `imageUrl?`, `price?`, `category`, `tags` (`stringListField`),
`recurring` (bool), `recurrenceLabel?` ("every Thursday"), `seriesKey?`, `firstSeenAt`,
`lastSeenAt`, `disappearedAt?`.

- **Identity / dedup**: unique index on `(sourceId, externalId)`; the engine upserts.
  A source type may supply `externalId`; when it can't (an LLM extraction can't), the
  engine derives `sha256(sourceId + normalizedTitle + startsAt::date)`. Deriving it in
  the **engine** rather than per-type is what keeps re-extraction idempotent by
  construction.
- **Disappearance is soft.** An event absent from a successful full extraction gets
  `disappearedAt` stamped, never deleted — a flaky scrape must not destroy rows the user
  may have annotated. Default views filter it out; a `defineRetention` sweep purges rows
  disappeared > 90 d.
- **Category is a closed list in `core/`**, not a slot: `["music","party","club","tech",
  "art","food","sport","community","other"]`. Per the root `CLAUDE.md` collection rule —
  it is enumerable today and both runtimes need it (the extraction prompt hands the model
  the exact list; the DataView renders it as an `enum` field). Promote to a registry only
  when a source type actually needs to add one.

**`event_source_runs`** — the run ledger, FK cascade. `sourceId`, `startedAt`,
`finishedAt`, `outcome` (`unchanged|extracted|failed`), `eventsFound/Created/Updated`,
`fingerprint`, `durationMs`, `error?`. This is what makes "why did nothing happen"
answerable; `defineRetention` keeps 30 days.

## Scheduling and caching

Two jobs in `refresh/`, both `defineJob` (`@plugins/infra/plugins/jobs/server`):

```ts
export const refreshTickJob = defineJob({
  name: "events.refresh-tick",
  input: z.object({}), event: z.never(), dedup: "singleton",
  schedule: { cron: "*/15 * * * *" },        // main-only: perWorktree left unset
  run: async () => { /* sources WHERE enabled AND refresh<>'manual' AND nextRunAt<=now()
                        → refreshSourceJob.enqueue({ sourceId }) */ },
});

export const refreshSourceJob = defineJob({
  name: "events.refresh-source",
  input: z.object({ sourceId: z.string() }),
  dedup: { key: (i) => i.sourceId },          // re-kicking a running source coalesces
  maxAttempts: 3,
  run: async ({ input }) => runSource(input.sourceId),
});
```

- A cron `defineJob` is the **documented exception** to the no-polling rule (mail's
  `sync-tick` sets the precedent): a scraped page has no push signal to subscribe to.
- **Main-only**, deliberately. Worktrees inherit events through the DB fork; a
  `perWorktree` schedule would have every live agent worktree independently hammering
  `fitzroy-paris.com`. Manual "Refresh now" is a normal endpoint and works in any worktree.
- `nextRunAt` is the watermark, so cadence changes take effect without touching the cron.

`runSource` is the whole engine, and is the only place that knows the phase order:

```
mark running → probe() → fingerprint === lastFingerprint ?
    yes → record run{outcome:"unchanged"}, bump nextRunAt, DONE (no model call)
    no  → extract() → derive externalIds → upsert diff → stamp disappearedAt
        → record run{outcome:"extracted"} → store fingerprint → bump nextRunAt
```

Each line is one high-level action; the low-level HTTP/LLM work lives behind the source
type. Errors classify to terminal/transient and land on the source row.

## The URL extractor (`sources/plugins/url-extract/`)

**probe** — `parsePublicUrl` → `safeFetch` (mandatory; SSRF-guarded, DNS-rebinding-safe)
→ stream through `HTMLRewriter` stripping `script`/`style`/`nav`/`footer` into visible
text, capped at ~256 KB, decoding entities exactly once via
`@plugins/infra/plugins/html-decode/core` (`decodeHtmlText` / `readHtmlAttr` — the
rewriter hands back raw markup; skipping this is the documented `d&#x27;` bug). Copy
`plugins/page/plugins/bookmark/server/internal/scrape.ts` for the streaming + cap shape.
`fingerprint = sha256(normalizedText)`.

> Fingerprint the **normalized visible text, not the raw HTML.** Raw HTML churns on every
> request (CSRF nonces, ad slots, build hashes) and would defeat the cache entirely.

**extract** — one-shot `runClaudePrint` (`@plugins/infra/plugins/claude-cli/server`):

```ts
const out = await runClaudePrint({
  tier: "sonnet",
  system: EXTRACTION_SYSTEM,          // schema + closed category list + horizon rules
  prompt: `URL: ${url}\nToday: ${today}\n${hint ?? ""}\n\n${pageText}`,
  timeoutMs: 120_000,
  source: { name: "events.url-extract", context: { sourceId } },
});
return ExtractedEventSchema.array().parse(extractJsonBlock(out));
```

No agent session — a one-shot is deterministic, cheap to retry, reuses local Claude auth,
and is already durably logged to `claude_cli_calls` (visible in Debug → Claude CLI calls).
A malformed / unparseable response is a `NonRetryableError` carrying the raw output onto
the run row, so a bad prompt is loudly visible rather than silently zero events.

**Recurrence, pragmatically.** Rather than an RRULE engine, the prompt instructs: for a
recurring event, emit **one row per concrete occurrence within the next 60 days**, all
sharing a `seriesKey`, with `recurring: true` and `recurrenceLabel: "every Thursday"`.
That yields a usable list and calendar with no new dependency, and re-extraction is
idempotent because `externalId = seriesKey + date`. Real RRULE storage + materialization
is a clean follow-up if weekly-page churn proves it necessary.

## The Events DataView (`event-list/`)

`defineDataView("events.list")`, **server-delegated** — the mail-inbox shape
(`data-view/plugins/server-query` + `primitives/keyset`), not client rows: the set grows
without bound and the user filters/sorts across all of it.

- `plugins/apps/plugins/mail/plugins/inbox/` is the template, file for file:
  `core/internal/fields.ts` (shared id vocabulary) → `web/internal/fields.tsx`
  (`FieldDef[]` with `value`/`cell`) → `server/internal/column-map.ts` (`FieldColumnMap`)
  → `server/internal/handle-query.ts` (`compileWhere` + keyset seek).
- Fields: `title` (text, primary), `startsAt` (date), `category` (enum), `venue`, `city`,
  `price`, `recurring` (bool), `tags`, `url`. Every typed field is automatically a filter
  and sort dimension — **do not bolt bespoke filter chips onto the toolbar.**
- `source` is contributed as a **field extension**, not hardcoded: the `sources` plugin
  contributes a `dynamic-enum` `source` field via `defineFieldExtensions`, exactly as
  `tasks/task-category` contributes `category` into the tasks DataView. The list plugin
  therefore names no source type, ever.
- `views={["list","table","gallery"]}`. **Calendar is a later `data-view/plugins/calendar/`
  view child** — a new view *type* registered into the global `DataViewSlots.View` slot,
  which every existing consumer opts into by adding one id. Zero changes to the Events app
  when it lands. That is precisely why the DataView route is right for this surface.
- Config is the only source of view instances: `./equin build` seeds
  `config/apps/events/event-list/…jsonc` and **fails `config:overrides-authored` until the
  `// @review` marker is deleted**. Author `Upcoming` (filter `startsAt >= today`,
  sort asc), `All`, `By category` (grouped) — then delete the marker and rebuild.

Freshness: a coarse `events` revision-tick live resource (mail's `changeTick` pattern) —
the change-feed fires it on any `events` write and the loaded pages refetch.

## UI surfaces

- `shell/` — `core/app.ts` `defineApp({ id: "events", basePath: "/events" })`;
  `Apps.App({ icon: mdAppIcon(MdEvent), … })`; `web/slots.ts` `Events.Sidebar`;
  `AppShellLayout` + `MillerColumns` body; a landing pane at bare `/events`. Mirror
  `plugins/apps/plugins/mail/plugins/shell/` file for file.
- `sources/` — an `Events.Sidebar` entry opening a sources pane (itself a DataView over
  `event_sources` — status, cadence, last run — per `no-adhoc-row-list`), a `+` menu built
  from `EventSources.Type.useContributions()`, and the **side-pane** `/events/s/:id` built
  with `defineDetailSections<{ sourceId }>("event-source-detail")`: a generic *Settings*
  section (the type's `configFields` through `FieldRenderer`), *Schedule* (cadence +
  Refresh now), *Status* (last run, error, classified remediation), *Runs* (the ledger).
  Sections are contributed, so a source type can add its own.
- `event-detail/` — `defineDetailSections<{ eventId }>("event-detail")`: summary, source
  provenance + link out, raw extracted payload (debugging a bad extraction).

Every new `defineRenderSlot` owes a reviewed reorder override — build, arrange `items`,
delete `// @review`, rebuild.

## Assumptions (overrule freely — they change scope, not shape)

1. **v0 ships `url-extract` + `manual`.** Shotgun and Meetup are designed-for and cost one
   small plugin each, but both need a credential and an API contract I cannot verify from
   here; building them blind risks reverse-engineered guesswork. Email is explicitly out
   per the request.
2. **Cadence set** is `manual | hourly | daily | weekly`.
3. **Recurrence** is materialized occurrences + a label, not RRULE (above).
4. **Calendar** is a follow-up view child, not v0.
5. **Events are worktree-local**, like all app data — the main instance is canonical and
   worktrees inherit via the DB fork. The refresh scheduler runs main-only.

## Delegation

`events-core` freezes every contract, so it must land **alone and first**; after that the
workstreams are genuinely parallel. Implementation agents on Opus; lookups on Sonnet.

| # | Workstream | Depends on | Deliverable |
|---|---|---|---|
| 0 | **`events-core`** — field records, 3 entities, `defineEventSourceType` registry, `EventSources.Type` slot, categories/cadences in `core/`, endpoint contracts, revision-tick resource | — | contracts frozen; `./equin build` green with a migration |
| 1 | **`shell`** — app entry, sidebar slot, layout, landing pane | 0 | Events app opens in the rail |
| 2 | **`refresh`** — both jobs, `runSource` engine, upsert/diff, run ledger, error classification, retention | 0 | a source can be refreshed end to end |
| 3 | **`event-list`** — DataView pane, fields, server query, column map, authored view config | 0 | events are browsable/filterable |
| 4 | **`sources`** — sidebar entry, sources DataView, `+` menu, source side-pane w/ generic `FieldRenderer` form, source field extension | 0, 1 | sources are addable in the UI |
| 5 | **`url-extract`** — probe (safeFetch + HTMLRewriter + sha256) & extract (Sonnet + zod) | 0, 2 | the Fitzroy URL yields real events |
| 6 | **`manual`** — trivial type; `probe` → `{fingerprint:null}`, events authored through the UI | 0, 2 | usable before any extractor works |
| 7 | *follow-ups* — `calendar` view child, `shotgun`, `meetup`, `ical`, RRULE materialization | 0 | — |

Each agent runs `./equin build` and must leave `./equin check` green,
including `config:overrides-authored` (DataView + reorder overrides authored, `// @review`
deleted) and `plugins-doc-in-sync`.

## Verification

1. `./equin build` → app at `http://<worktree>.localhost:9000/events`.
2. **Contract**: `bun test` on the pure units — externalId derivation, the upsert/diff
   (`created/updated/disappeared` counts), error classification, and the extraction
   response parser against a captured fixture. These are `*.test.ts` next to source.
3. **End to end**: add a URL source for the Fitzroy page → events appear; hit *Refresh
   now* again → the run ledger reads `unchanged` and `query_db` shows **no new
   `claude_cli_calls` row** (this is the cache assertion, and it is the one most worth
   proving);
   `select outcome, events_created from event_source_runs order by started_at desc limit 5`.
4. **UI**: `bun plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts
   --url http://<worktree>.localhost:9000/events --click "Sources" --out /tmp/events`,
   then a per-plugin `e2e/events-verify.ts` driving add-source → refresh → list.
5. **Failure paths, deliberately**: point a source at a 404 and at a private IP
   (`http://127.0.0.1`) — the first must land as a classified terminal error on the source
   row, the second must be refused by `safeFetch` and never reach the model.

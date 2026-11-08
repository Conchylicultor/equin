# engine

The reports ENGINE: everything that writes the `reports` table, and the
process crash capture that feeds it — `recordReport` (and its debounced
variant), the HTTP routes (`POST /api/reports`, `POST /api/reports/:id/investigate`),
the process-crash handler and the on-disk crash buffer, the change producer, the noise
backfill, retention, investigation and the uninvestigated reads, and the fork
exclusion.

Its parent (`reports`) is the PORTABLE half — the table, `reports.list`, the
`ReportKind` / `ReportNoiseRule` slots, the fan-out config and the contracts
(`reportInvestigationSink`, `reportRecordedSignal`) — which every host boots,
the browser's worker included. This half needs the computer (a synchronous file
append on a dying event loop, the desktop database's change producer and fork
admin), so it is a non-portable `server/` barrel: other plugins' `server/` code
calls `recordReport`, which a `machine/` barrel could not offer them. A host
without the computer never loads it, so it records nothing and its
`reports.list` is the seed, read-only (see the parent's *Readers are live*).

## Two throttles, on two axes

`recordReport` gates every occurrence on both, and they are not
interchangeable:

- **Per fingerprint** (`server/internal/velocity.ts`) — one fingerprint firing
  repeatedly still gets its row and its count; only the bell churn is skipped.
- **Across fingerprints, per kind** (`server/internal/fan-out.ts`) — how many
  DISTINCT fingerprints of one kind may each raise their own alert per window
  (`reports.fanOutPerWindow`, default 20). Past the budget a newly-alerting
  fingerprint writes no row and no notification; it folds into one
  `report-storm` rollup (kind owned by `plugins/debug/plugins/report-storm`).
  A repeat of an already-alerting fingerprint is NOT fan-out and passes
  through untouched, and the budget refills every window — so collapse is
  temporary. A kind may raise its own ceiling via `meta.fanOutPerWindow`;
  there is deliberately no way to remove one.

`recordReport` therefore returns a discriminated `RecordReportResult`
(`recorded` | `shed` | `collapsed`) — "the engine took ownership" must never
read as "recorded with no id".

## The bell re-alerts; a kind cannot opt out

A report IS a problem, and a problem that recurs after you dismissed it is news.
So the bell's re-alert window has a floor (`RENOTIFY_FLOOR_MS`, 10 min in
`record-report.ts`) and `meta.notifCooldownMs` is only ever a RAISE above it —
same shape as `meta.fanOutPerWindow`, and deliberately no spelling for "never".
A dismissed row comes back unread on the next occurrence past the window;
occurrences inside it only bump `count`.

## One incident, one bell

`recordReportIncident(inputs)` files reports one cause produced at one instant,
most significant first. Each lands on its own fingerprint exactly as through
`recordReport`: row, count, velocity, fan-out and shed. Then ONE notification
rings for the incident instead of one per row. It is the first report whose row
is new (never seen in this worktree) when there is one, so a new problem always
alerts unread. Otherwise it is the lead (`pickIncidentBell`). Its description
leads with `[+N related, M new]`, and its metadata lists every member
(`incidentReportIds`). Identity stays per problem and only the alert is shared.
So never merge co-occurring reports into one fingerprint to quiet the bell:
that puts unrelated incidents on one row and hides the member that only ever
co-occurs. First user: slow-ops' per-batch bursts.

## Every write goes through the producer

`reports` has no change-feed trigger. A crash loop UPDATEs its hot row thousands
of times a minute, and a per-statement trigger + changelog row + NOTIFY would
amplify load during the very storms it records. Instead the table has an
in-process **change producer** (`server/internal/producer.ts`,
change-feed's `defineChangeProducer`): every write is
`reportsProducer.mutate(db, (q, t) => <builder on t>, { latency })`, which runs
the statement, reads the PKs it returned and routes them to the tuples reading
them — coalesced to one flush per 2 s, so a storm costs each reader one scoped
refill per window. The four writers: `recordReport` (`writeReport`, background —
the rate-limited path routes too), `investigateReport` (interactive: flushes at
once), the noise reconcile (one statement per flip) and the nightly
retention sweep (retention deletes through the producer when the table has one).

Rules that follow:

- **A new writer goes through `reportsProducer.mutate`.** A bare
  `db.update(_reports)` — or raw SQL writing `reports` — reaches no live reader;
  the `change-feed:producer-writes` check fails on it.
- **Only the serving backend writes.** `mutate` throws in an exec child (a
  supervised job body) or a CLI: its change would reach no subscriber. Such a
  process files through the outbox (below) — and `recordReport` does that by
  itself: when `reportsProducer.writesHere()` is false it hands the report to
  `reportOutboxSink` (result `{ outcome: "outbox" }`), whose writer the outbox
  plugin attaches in every boot mode. So a sink handler that files reports
  (a missed query deadline, an ended idle transaction) works unchanged in a
  supervised child.
- **Volatile.** A change still pending in the 2 s window is lost on a restart;
  an open reader reloads in full when it resubscribes. Within one subscription a
  lost change heals the window's membership but not the values of rows already
  shown. No reader of `reports` may be L2-persisted (A6, live-state-snapshot).
- **The bell and the pane disagree during a burst, by design.** While a
  fingerprint is rate-limited the bell stays quiet, but its row's count keeps
  moving in an open pane (every 2 s).

## Typed server reports: `serverReportSink` and `serverFatalSink`

server-core files a typed report (`kind` + `data`) one of two ways, decided by
whether the process lives on:

- **`reportServer`** — the process keeps running (a narrower jobs runner
  forfeited, a restart the anti-loop latch suppressed). A held sink the engine
  handles with plain `recordReport`, async (`serverReportHandler`).
- **`exitWithFatalReport(report, exit)`** — the process exits on the spot (the
  jobs runner floor, a dead runner). It takes the exit and returns `never`, so
  a synchronous report from a process that lives on has no spelling. The
  engine's `serverFatalSink` handler (`fatalReportHandler`) writes
  synchronously: the serving backend appends a line naming its kind to its
  crash buffer (replayed by its next boot's `flushBufferedReports`); any other
  process (an exec child) hands it to `reportOutboxFatalSink`, which
  `reports/outbox` writes synchronously.

Both handlers are `sinkHandlers` entries (`server/internal/fatal.ts`), attached
in every boot mode.

## Sync writes only on a dying process

`server/internal/crash-append.ts` is the one synchronous file append (a
sanctioned `blocking-fs/no-sync-fs` exemption), and only the dying path
reaches it: the crash handler's `crash-buffer-sync` lane (an uncaught
exception on the serving backend) and the `serverFatalSink` handler. A sync append on a backend that lives on freezes its
JS thread for as long as the disk answers (3-13 s stalls on main), so every
path a serving backend survives — a rejection, `reportServer` — records
asynchronously. Never import it from anywhere else.

## Process crashes: `processCrashSink`

An uncaught exception or unhandled rejection is caught by server-core's own
listeners, which each process entry point (`serve`, `runExec`) installs before
the graph loads, and dispatched to `processCrashSink`. The engine handles it
through `sinkHandlers` (`server/internal/process-hooks.ts`), so an exec child's
crash — a supervised job's body throwing outside its await chain — is filed
too. Where it is written is one decision, `crashWriteLane(event, serving)`:
a synchronous write is safe on a dying process (an uncaught exception: the
listener exits 1 next) and on one that does not serve (an exec child, a CLI, a
serving backend still booting), and freezes only a serving backend that lives
on. So:

- **uncaught exception, serving** (the ready backend): its crash buffer, sync;
- **not serving, either event**: `reportOutboxFatalSink`, sync — durable
  before the handler returns, so a boot that rejects and then exits, or an
  exec child's rejection after its shutdown drained the async writes, is still
  filed; with no outbox writer attached it answers false and says so;
- **unhandled rejection, serving** (survived): `recordReport`, async; a failed
  write is printed. Before the handler attaches,
the serving backend's boot crashes belong to `debug/boot-events`. The engine
installs no listener itself: `server-core/no-process-crash-listener` forbids it.

## Noise is judged when recorded, re-judged only when the rules change

`noise` (and the bell's `muted`) is computed by `recordReport` from the
`ReportNoiseRule` contributions and the row's own fields — `staleOrigin`
included, which is a fact of the occurrence: the reporting tab's bundle
against the graph the server served AT THAT MOMENT, stored on the row and
never re-derived (judging an old row against today's graph calls every report
filed before the last deploy stale; it did, 2026-06 → 2026-11, muting real
crashes on the first boot after each push).

So the stored flags only go stale when the rules' code changes. The
`reports.backfill-noise` warm-up stamps them with the source digest of that
code (every rule's `code` module plus `noise-input.ts`, the row → rule input
mapping) in `reports_reconciled`; a boot whose digest matches reads one row
and stops. Only a changed digest re-runs the O(reports) pass (every row
re-judged, every linked notification's `muted` synced). Keep a rule's module
and `noise-input.ts` importing nothing but types — whatever they load counts.

## Filing from a process with no server

`recordReport` runs inside a backend. A process with no server — a
`./equin` CLI run, a supervised child — files through the **report
outbox** instead (`plugins/reports/plugins/outbox`): `fileReportFromProcess`
writes one JSON file into a host-global directory, and main's backend records it
under the server-only `cli` source. An entry may carry the writer's merge-base
and the files it is about; main drops it when it has changed those files since,
so out-of-date code does not file reports. See that plugin's CLAUDE.md.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Records server/frontend crashes as deduped reports (recordReport: per-fingerprint velocity, per-kind fan-out ceiling, duress shedding, bell notifications), files investigation tasks on demand, files every crash the process's listeners catch (processCrashSink, in every boot mode: an uncaught exception synchronously — the crash buffer from a ready serving backend, the report outbox from anything else — and a survived rejection asynchronously), files server-core's typed reports (reportServer, async; exitWithFatalReport, synchronously on the way out) and replays the on-disk crash buffer, and owns the reports table's change producer, retention and fork exclusion.
- Server:
  - Contributes:
    - `change-producer` "reports"
    - `fork-data-exclusion` "reports"
  - Uses: 22 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `reports` ×8
    - `shell/notifications` ×3
    - `infra/host/duress/shed` ×2
    - `build/server-build-id.getServerGraphHash`
    - `config_v2.getConfig`
    - `database/admin.ExcludeFromFork`
    - `database.db`
    - `infra/endpoints.implement`
    - `infra/retention.defineRetention`
    - `infra/warmup.defineWarmup`
    - `network/live/change-feed.defineChangeProducer`
    - `packages/source-digest.sourceDigest`
  - DB schema: `plugins/reports/plugins/engine/server/internal/tables.ts`
  - Exports (types):
    - `RecordReportResult`
    - `RestateOccurrence`
    - `RestateResult`
    - `StormRosterEntry`
    - `StormSummary`
  - Exports (values):
    - `DEFAULT_REPORT_DEBOUNCE_MS`
    - `investigateReport`
    - `linkReportsToTask`
    - `recordReport`
    - `recordReportDebounced`
    - `recordReportIncident`
    - `renderReportTask`
    - `reportOutboxFatalSink`
    - `reportOutboxSink`
    - `restateReportOccurrence`
    - `uninvestigatedReportCounts`
    - `uninvestigatedReports`
  - Register:
    - `defineWarmup('reports.backfill-noise')`
    - `defineJob('retention.reports')`
- Machine:
  - Uses: `infra/endpoints.implementMachine`
- Cross-plugin:
  - Imported by: 29 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `debug` ×11
    - `conversations` ×4
    - `database` ×3
    - `infra` ×3
    - `reports` ×3
    - `backup`
    - `page/place/google`
    - `stats/cost`
    - `tasks/reports-investigation`
    - `upstream`
- Exemptions:
  - Exempts itself from:
    - `sink-safety/no-adhoc-file-sink` — `server/internal/crash-append.ts` (sanctioned)
    - `blocking-fs/no-sync-fs` — `server/internal/crash-append.ts` (sanctioned)
    - `boundaries/no-platform-api` — `server/internal/buffer.ts`, `server/internal/crash-append.ts` (debt)

<!-- AUTOGENERATED:END -->

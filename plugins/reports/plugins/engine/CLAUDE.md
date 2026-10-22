# engine

The reports ENGINE: everything that writes the `reports` table, and the
process crash capture that feeds it — `recordReport` (and its debounced
variant), the HTTP routes (`POST /api/reports`, `POST /api/reports/:id/investigate`),
the crash hooks and the on-disk crash buffer, the change producer, the noise
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
once), the boot noise backfill (one statement per flip) and the nightly
retention sweep (retention deletes through the producer when the table has one).

Rules that follow:

- **A new writer goes through `reportsProducer.mutate`.** A bare
  `db.update(_reports)` — or raw SQL writing `reports` — reaches no live reader;
  the `change-feed:producer-writes` check fails on it.
- **Only the serving backend writes.** `mutate` throws in an exec child (a
  supervised job body) or a CLI: its change would reach no subscriber. Such a
  process files through the outbox (below).
- **Volatile.** A change still pending in the 2 s window is lost on a restart;
  an open reader reloads in full when it resubscribes. Within one subscription a
  lost change heals the window's membership but not the values of rows already
  shown. No reader of `reports` may be L2-persisted (A6, live-state-snapshot).
- **The bell and the pane disagree during a burst, by design.** While a
  fingerprint is rate-limited the bell stays quiet, but its row's count keeps
  moving in an open pane (every 2 s).

## Filing from a process with no server

`recordReport` runs inside a backend. A process with no server — a
`./singularity` CLI run, a supervised child — files through the **report
outbox** instead (`plugins/reports/plugins/outbox`): `fileReportFromProcess`
writes one JSON file into a host-global directory, and main's backend records it
under the server-only `cli` source. An entry may carry the writer's merge-base
and the files it is about; main drops it when it has changed those files since,
so out-of-date code does not file reports. See that plugin's CLAUDE.md.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Records server/frontend crashes as deduped reports (recordReport: per-fingerprint velocity, per-kind fan-out ceiling, duress shedding, bell notifications), files investigation tasks on demand, installs the process crash hooks and replays the on-disk crash buffer, and owns the reports table's change producer, retention and fork exclusion.
- Server:
  - Contributes:
    - `change-producer` "reports"
    - `fork-data-exclusion` "reports"
  - Uses:
    - `build/server-build-id.getServerGraphHash`
    - `config_v2.getConfig`
    - `database.db`
    - `database/admin.ExcludeFromFork`
    - `database/change-feed.defineChangeProducer`
    - `infra/endpoints.implement`
    - `infra/host/duress/shed.createShedBuffer`
    - `infra/host/duress/shed.ShedSummary`
    - `infra/retention.defineRetention`
    - `infra/warmup.defineWarmup`
    - `reports._reports`
    - `reports.reportInvestigationSink`
    - `reports.ReportKind`
    - `reports.ReportNoiseInput`
    - `reports.ReportNoiseRule`
    - `reports.reportRecordedSignal`
    - `reports.ReportRow`
    - `shell/notifications.recordNotification`
    - `shell/notifications.setMutedByMetadata`
  - Exports (types):
    - `RecordReportResult`
    - `StormRosterEntry`
    - `StormSummary`
  - Exports (values):
    - `DEFAULT_REPORT_DEBOUNCE_MS`
    - `investigateReport`
    - `linkReportsToTask`
    - `recordReport`
    - `recordReportDebounced`
    - `renderReportTask`
    - `uninvestigatedReportCounts`
    - `uninvestigatedReports`
  - Register:
    - `defineWarmup('reports.backfill-noise')`
    - `defineJob('retention.reports')`
- Machine:
  - Uses: `infra/endpoints.implementMachine`
- Cross-plugin:
  - Imported by: 21 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `debug` ×9
    - `conversations` ×2
    - `database` ×2
    - `reports` ×2
    - `backup`
    - `infra/jobs/deadline-audit`
    - `page/place/google`
    - `stats/cost`
    - `tasks/reports-investigation`
    - `upstream`
- Exemptions:
  - Exempts itself from:
    - `sink-safety/no-adhoc-file-sink` — `server/internal/buffer.ts` (sanctioned)
    - `boundaries/no-platform-api` — `server/internal/buffer.ts` (debt)

<!-- AUTOGENERATED:END -->

# import

Pulls the errors and slowness a deployed site's visitors hit into this
computer's Reports (Debug → Reports, the bell), marked as **website
visitors**: source `website-visitor`, a "Website visitors" badge and view.
Design and threat model:
`research/2026-11-12-global-website-visitor-reports-import.md`.

## Two kinds, by the site kind's own category

A site report keeps its category here. The sink files each row as
`website-visitor-error` (category `error`, an error bell) or
`website-visitor-slowness` (category `slow-op`, a warning bell: "A website
visitor's page was slow"), picked by `importedKindOf`:

1. the row's `category`, which the site's intake stamps from the site's own
   `ReportKind` registry — the authority, since the site registers kinds this
   computer never does (`slow-page-load` sits under the excluded `channel`);
2. a row from a box released before the intake stamped it (`category` absent
   or null): this computer's registry (`reports/server`'s
   `reportKindCategory`);
3. neither knows the kind (a site running newer code): an error — shown,
   never dropped, in the lane that gets looked at.

So a visitor's slow page load, main-thread stall, slow interaction or render
loop reaches every slow-op reader (the supervisors' Slow-op reports stream),
never the error ones.

Both kinds share the payload, the fingerprint and the summary view. The
fingerprint is the same `(deployment, site fingerprint)` for both, and the
engine's upsert keeps a row's kind, so the rows imported as errors before the
split were re-kinded in place by a data migration
(`…__website_visitor_slowness_rekind`): their ids, and so the fix ledger's
claims on them, carry over.

A box upgraded to a release with the `category` column changes its table's
fingerprint, so this computer reconciles once: every row's hash moved, so
each is handed again as a recurrence (`alert: false`, no bell; `count` +1).

The content is untrusted: anonymous strangers can make the site's intake hold
anything within its bounds. Every rule below exists so that cannot reach the
user's machine as anything but inert, bounded data.

## Pull, never push — a change stream, reduced as it arrives

The box's intake declares `site_reports` as a mirror set (`site_reports`), and
this plugin reads it through the deploy app's
[`site-mirror`](../../../site-mirror/CLAUDE.md) as a **change stream with the
reduce step as its sink** (`SiteMirrorSink`, `server/internal/reduce-sink.ts`),
never as a copy. Design: `research/2026-11-12-global-table-mirror.md` § Phase 4.

- The hourly, main-only `site-mirror.pull-all` keeps one replica of the set
  per deployment and pulls it. The computer SSHes out (the Deploy app's pinned
  host key and deploy key) and curls the box's host-only mirror routes. Nothing
  on the internet can write to this machine: there is no inbound endpoint. It
  runs on a schedule because the box has no change signal that reaches here.
- **No raw row is stored here.** The replica keeps only the content-free key
  index `table_mirror_keys` (each row's key and hash); the sink parses and
  reduces each row in the page's transaction and keeps only the reduced form,
  as a report. `query_db` for a visitor's string finds nothing.
- **Nothing is skipped.** The xid cursor replaces the old `lastSeenAt`
  watermark over the newest 100 rows, which lost rows that fell off that page.
  A row is handed to the sink only when its hash changed (a new fingerprint, a
  recurrence), so a re-delivery never counts twice.
- **Reconciliation** (the computer was off past the box's 30-day log horizon,
  or the box was reinstalled) fetches only rows whose hash differs from the key
  index; the sink records them with `alert: false` — a catch-up rings no bell.
- **Tombstones are ignored**: the box's 30-day sweep forgetting a fingerprint
  is not news; the local report has the engine's own retention.

A failed pull (no key, SSH failed, the request failed, the answer was
unreadable or oversized, the site's release does not serve the set) records
nothing and is the replica's `last_outcome` (`site-mirror.status`). A row that
does not parse throws: the page applies nothing, the pull's `run_error` says
why, and the next hour retries it.

## Structured data only

`reduceSiteReport` (`core/internal/reduce.ts`, pure) is the gate. The site's
kind payload is never copied — it is reduced. What is kept:

- the message as one plain line: control and bidi characters gone, URLs
  removed, `` ` < > [ ] `` replaced, at most 300 characters;
- the error type as one plain line, sanitised like the message, at most 120
  characters (a collector's family such as `EndpointError 500 POST /api/x`
  names what failed when the message cannot);
- the stack, reduced to `{ file, line, column }` frames on the site's own
  origin (or relative), each file a safe pathname, at most 15;
- the visitor page's source (`CLIENT_REPORT_SOURCES`, else `other`);
- path, build and commit, each matched against a strict pattern (else null);
- clamped counts and parsed timestamps;
- for a `main-thread-stall` report only, its evidence (`stall`,
  `VisitorStallSchema`; `reduceStall`): the payload parsed with the stall
  kind's own schema, then reduced to detector (`worker` / `in-tab`), how it
  ended, duration, visibility and focus, long frames during it, the covering
  LoAF frame's split (script, pause, forced style/layout, render start), its
  longest scripts and sampled self-time functions **by identifier-shaped name
  only** (no URL, source position, route or mark text), and the browser's
  coarse family and OS (`StallClientSchema` — never the user agent). A
  payload that no longer parses is `unreadable`, never guessed at. Without it
  a visitor's stall could not be investigated: the message alone does not say
  whether the page was busy or its process suspended.
- for every kind, the payload itself reduced structurally (`payload`,
  `VisitorPayloadSchema`; `reducePayload`) — so a report is diagnosable from
  the local row alone (a crash's stack with its function names and its
  cause, a resize-loop trace's elements and owners, an adaptive bar's or a
  render loop's evidence), and a kind added later needs no code here. Keys
  must be identifier-shaped (never `__proto__` / `constructor` /
  `prototype`); numbers, booleans and nulls are kept as they are; every
  string is one plain line sanitised like the message, with a URL on the
  site's own origin cut to its path (query dropped) and every other URL
  removed; a multi-line string (a stack) becomes a list of such lines. At
  most 6 deep, 30 fields per object, 20 items per list, 300 characters per
  string, 300 values and 8,000 characters in all, in the site's order; every
  value dropped is counted in `omitted`. Before it, the evidence named only
  by a kind's payload (the resize-loop trace — the only thing naming the
  looping observer, since the browser gives that error no stack) survived
  only in the box's raw row, which nothing here may read.

The result is parsed with the kind's strict schema (`WebsiteVisitorErrorSchema`)
here and again in `recordReport`.

## Never rendered as markup

`WebsiteVisitorSummary` and the Reports pane render text nodes only. The task
that Investigate files is built from typed fields, with the message in a code
span. The engine fences the whole body inside a code block
(`fenceUntrustedReport`), so markdown renders nothing from it.

## No automatic agent

`website-visitor` is in `reports/core`'s `UNTRUSTED_REPORT_SOURCES`. The
engine's worklist, which the Report investigations automation and every other
automation read, leaves those sources out. A report from them is investigated
only by hand. Both briefings, the task the engine files and the first turn the
web Investigate sends, fence the content as data and never as instructions.

## Bounded here too

- At most 50 rows per deployment per run (`IMPORT_PACE`): ONE page per hourly
  pull, never followed up, a pull within 50 minutes of the last skipped, and
  the sync endpoint never pulls the set. A backlog drains 50 an hour, oldest
  change first. The answer is capped at 1 MB (row JSON cut at 250 KB on the
  box), and the sink throws on a page past 50 rows.
- There is one row per (deployment, site fingerprint).
- Each page is one incident (`recordReportIncident`), so it rings one bell at
  most.
- More than 20 new fingerprints in a window collapse into one `report-storm`
  row (the engine's fan-out ceiling).
- A known error re-alerts at most daily (`notifCooldownMs` 24 h).

The local row's `count` is the number of pulls that saw the error recur. The
site's own total is `siteCount` in the payload.

Tests: `./equin test plugins/apps/plugins/deploy/plugins/site-reports/plugins/import`
(the reduction, the row parse, the sink's bounds, the kind by category); the stream, re-delivery and
reconcile mechanics are `table-mirror/replica`'s suite.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Errors and slowness a deployed site's visitors hit, read hourly from the site's box over SSH (its mirror change stream, reduced as it arrives) into this computer's Reports as untrusted website-visitor reports (never auto-investigated, fenced as data when investigated by hand). Web half: both kinds' Debug → Reports summary view — a Website visitors badge, then the site, the page and the visitor's error as plain text (never markup or a link) with the site's own occurrence count. Reads the errors and slowness a deployed site's visitors hit into this computer's Reports: the box's site_reports change stream (site-mirror, outbound SSH only) goes through the reduce step as the replica's sink — every row strictly parsed and reduced to typed, clamped fields, the site's payload never copied but reduced structurally (identifier keys, typed scalars, every string a sanitised plain line, capped and counted — so every kind's diagnostic data reaches the local report), no raw row stored here (only the mirror's content-free key index) — at most 50 rows per deployment per hourly run, each page ONE incident, each row of the website-visitor-error or website-visitor-slowness kind by its site kind's own category (so a visitor's slow load or freeze is a slow op here too) (a reconciliation's catch-up rings no bell), source website-visitor — untrusted: never on the worklist automations read, fenced as data when investigated by hand.
- Web:
  - Contributes:
    - `Reports.KindView` → `WebsiteVisitorSummary`
    - `Reports.KindView` → `WebsiteVisitorSummary`
  - Uses:
    - `primitives/css/badge.Badge`
    - `primitives/css/cluster.Cluster`
    - `reports.Reports`
- Server:
  - Contributes:
    - `report-kind` "website-visitor-error"
    - `report-kind` "website-visitor-slowness"
    - `site-mirror-sink` "site_reports"
  - Uses:
    - `apps/deploy/site-mirror/pull.SiteMirrorSink`
    - `primitives/log-channels.Log`
    - `reports.ReportKind`
    - `reports.reportKindCategory`
    - `reports.ReportRow`
    - `reports/engine.recordReportIncident`
- Core:
  - Uses:
    - `packages/list-bound.cappedList`
    - `packages/list-bound.cappedRecord`
    - `packages/string-hash.hashHex`
    - `primitives/pane.pathWithoutSurfaceViews`
    - `reports.CLIENT_REPORT_SOURCES`
    - `reports/crash.CodeOriginSchema`
    - `reports/main-thread-stall.CLIENT_FAMILIES`
    - `reports/main-thread-stall.CLIENT_OSES`
    - `reports/main-thread-stall.MainThreadStallPayloadSchema`
  - Exports (types):
    - `SiteContext`
    - `VisitorPayload`
    - `VisitorStackFrame`
    - `VisitorStall`
    - `WebsiteVisitorError`
  - Exports (values):
    - `reduceSiteReport`
    - `VISITOR_ERROR_LIMITS`
    - `WEBSITE_VISITOR_ERROR_KIND`
    - `WEBSITE_VISITOR_SLOWNESS_KIND`
    - `WebsiteVisitorErrorSchema`
    - `websiteVisitorErrorSummary`

<!-- AUTOGENERATED:END -->

# Website visitors' error reports, pulled into the computer's Reports

Task: att-1794444288. Follows `research/2026-11-11-global-website-demo-error-reports.md`
(the site's public intake, `apps/deploy/site-reports/intake`).

## Context

The standalone website collects the errors its visitors hit, on its own box
(`site_reports`, one row per fingerprint, read by the host-only
`GET /api/host-only/site-reports`). Nobody looks there.

**User decision (2026-11-12):** these reports show up in the user's own
Reports system (Debug → Reports, the bell), marked so it is obvious that they
come from website visitors: their own source, badge and filter.

The content is **untrusted input from anonymous strangers**. The user asked
whether an attacker could use it to get into their computer. This design is
built so that cannot happen.

## Threat model

**Attacker:** anyone on the internet. They can POST anything to
`/api/site-reports`, within the intake's bounds: up to 10 entries per batch,
a 1,000-character message, a 4 KB `data` payload, any `path`, any
`buildId` or `commit`.

The attacker wants one of these:

| # | Goal | Vector | Defence |
|---|------|--------|---------|
| T1 | Reach the computer directly | an inbound endpoint on the user's machine | **Pull only.** The computer's main backend runs a scheduled job. It SSHes out to the box, using the Deploy app's pinned host key and the deploy key, and reads the host-only list. Nothing new listens on the computer. The website's server cannot write to the user's machine at all: it only answers a curl run over SSH. |
| T2 | Smuggle payload through the transfer | oversized or odd JSON | The answer is capped in bytes (`maxAnswerBytes`: curl `--max-filesize` on the box, plus a length check before parsing). The page is capped in rows (`limit`). It is zod-parsed as `SiteReportsPage` (strict). |
| T3 | Store arbitrary content on the computer | free text in `message` and `data` | **Structured reduction** (`reduceSiteReport`, pure, tested). Only typed, clamped fields are kept. **The site's `data` is never copied.** <br>• The message: control and bidi characters stripped, whitespace collapsed, at most 300 characters. <br>• An identifier-shaped `errorType`. <br>• Stack frames parsed out of `data.stack`, each reduced to `{ file, line, column }`. Only frames on the site's own origin (or relative) are kept, and the file must be a pathname of `[A-Za-z0-9/._@-]`. At most 15 frames; the rest are counted. <br>• Visitor `source`: one of `CLIENT_REPORT_SOURCES`, else `other`. <br>• Site `kind`: identifier-shaped. <br>• `path`: a pathname of a safe alphabet, at most 200 characters. <br>• `buildId` and `commit`: hex or identifier-shaped, else null. <br>• Counts: clamped integers. Timestamps: parsed. <br>Then the kind's own strict zod `schema` validates the result again in `recordReport`. |
| T4 | Run script or track the user in the app | HTML, markdown or links in the message | **Never rendered as markup.** The kind's view and the Reports pane render React text nodes only (no `dangerouslySetInnerHTML`, no markdown, no `href`). The reduced record contains no URL (frames are pathnames). |
| T5 | Prompt-inject an agent that has shell and repo access | "ignore previous instructions…" in a message | Two parts: <br>• **No agent runs on them automatically.** The source `website-visitor` is in `UNTRUSTED_REPORT_SOURCES` (`reports/core`). The engine's `reportWorklist` / `reportWorklistCounts` leave those sources out by construction, so the Report investigations automation, and any future automation built on the worklist, can never pick one up, whatever its config says. <br>• **The manual Investigate marks them as data.** Both places that brief an agent (the server's `renderReportTask` and the web Investigate prompt) wrap the report's body in `fenceUntrustedReport` (`reports/core`). That fence is a preamble saying the content was written by anonymous strangers and is data, never instructions, plus a delimited block. Any delimiter text inside the content is neutralised. |
| T6 | Flood the computer's DB or bell | many fingerprints or counts on the site | Several bounds: <br>• Per run: at most `MAX_IMPORT_PER_RUN` (50) changed fingerprints per deployment, and at most `MAX_DEPLOYMENTS` (20) deployments. <br>• Hourly schedule, main only. <br>• Aggregated: one local row per (deployment, site fingerprint). A repeat updates that row. <br>• Each run is ONE incident (`recordReportIncident`), so one bell per run at most. The engine's fan-out ceiling collapses more than 20 new fingerprints per window into one storm row. <br>• The kind's `notifCooldownMs` is 24 h, so a known fingerprint re-alerts at most daily. <br>• The engine's retention sweeps old rows. |

## Design

### 1. `reports`: untrusted sources, as closed data

The changes are in `reports/core/sources.ts` and a new `untrusted.ts`.

- **A new server-only source, `website-visitor`.** It is in `SERVER_REPORT_SOURCES`, so the browser's `POST /api/reports` cannot claim it, because that body is `z.enum(CLIENT_REPORT_SOURCES)`.
- **`UNTRUSTED_REPORT_SOURCES = ["website-visitor"]`** lists the sources whose content strangers wrote, with `isUntrustedReportSource(source)`.
- **`fenceUntrustedReport(body)`** wraps a briefing in the untrusted-data preamble and fence.

### 2. Engine: the worklist excludes untrusted sources, and the briefing fences them

In `reports/engine/server/internal/uninvestigated.ts`:

- The `worklist` predicate gains `notInArray(_reports.source, UNTRUSTED_REPORT_SOURCES)`.
- `renderReportTask(row)` fences the kind's description when `row.source` is untrusted. This is the one function both Investigate and the automation brief through.

The web Investigate prompt (`debug/reports/web/components/report-investigate.tsx`) fences its body the same way.

### 3. host-query: a byte cap

`hostOnlyQueryOverSsh(deploymentId, path, schema, { maxAnswerBytes? })`:

- curl gets `--max-filesize N`.
- `mapSshAnswer` refuses stdout longer than N as `unreadable-answer` before `JSON.parse`.

### 4. New plugin `apps/deploy/site-reports/plugins/import`

It lives in the local app only. It imports host-query, which reaches SSH, so a deployed closure never takes it.

- **`core/`**
  - `WEBSITE_VISITOR_ERROR_KIND`.
  - `WebsiteVisitorErrorSchema`: strict, every field typed and bounded.
  - `reduceSiteReport(record, { deploymentId, hostnames })`: the T3 gate.
  - `websiteVisitorErrorSummary(data)`: a plain-text one-liner.
- **`server/`**
  - **The `ReportKind`** `website-visitor-error`.
    - Fingerprint: `<deploymentId>:<site fingerprint>`.
    - Variant: `error`.
    - `notifCooldownMs`: 24 h.
    - Notif text: "A website visitor hit an error".
    - `renderTask`: plain lines, fenced by the engine.
  - **The table `site_report_imports`**: `deployment_id` PK (cascade on the deployment), `watermark` (the newest site `lastSeenAt` imported), `last_run_at`, `last_outcome`. One row per deployment.
  - **The job `site-reports.import`**: hourly cron, main only, `hold: "minutes"`, `dedup: "singleton"`. For each deployment (at most 20):
    1. Read the host-only list (`limit` 100, `maxAnswerBytes` 1 MB).
    2. Keep the rows whose `lastSeenAt` is past the watermark, oldest first, at most 50.
    3. Reduce each row.
    4. Record them as one incident, with source `website-visitor`, `occurredAt` set to the site's `lastSeenAt`, and `url` null.
    5. Advance the watermark to the last row taken.

    A failure (SSH, request, unreadable answer) files nothing. It is logged and stored as `last_outcome`; the Deploy app's health already reports an unreachable box.

    A site whose composition does not ship the intake answers HTTP 404, which surfaces as curl exit 22, and is skipped the same way. The server cannot cheaply resolve a composition's closure, and the box is the authority on what it serves.

    *Why a schedule:* the box has no change signal that reaches the computer, and a push from the box would be the inbound path T1 forbids.
- **`web/`**
  - `Reports.KindView` for the kind: a "Website visitors" badge, the site's hostname, `errorType: message`, the top frame and the site's own occurrence count, all as text.

### 5. Debug → Reports: a "Website visitors" view

A `scoped({ where: { source: "website-visitor" } })` source sits in the view bar. Each row also carries the source badge, and the Source facet already filters by it.

## Count semantics

The local row's `count` is how many hourly pulls saw the error recur. The site's own total is in the payload (`siteCount`), and the kind view shows it.

`recordReport` only adds 1 per call. Replaying N calls would turn a flood on the site into N writes on the computer.

## Tests

- `reduce.test.ts`:
  - A malicious message (HTML/script, markdown link, ANSI, bidi, NUL, newlines) comes out a single plain line, clamped.
  - An oversized message is clamped.
  - Foreign-origin and `javascript:` frames are dropped.
  - Every string in the result is within the alphabet and length bounds.
  - Arbitrary `data` keys never come through.
  - An injection-looking message survives only as data.
- `untrusted.test.ts` (reports/core): the fence neutralises an embedded closing delimiter. Only `website-visitor` is untrusted.
- `import.test.ts` (pure planner):
  - The watermark filter.
  - The per-run cap.
  - Oldest-first order.
  - The watermark advances only to what was taken.
- Engine (`uninvestigated.db.test.ts` or a pure predicate test): a `website-visitor` report never enters `reportWorklist`, at any `minCount`. `renderReportTask` fences it.
- host-query `query-over-ssh.test.ts`:
  - An answer over `maxAnswerBytes` comes back `unreadable-answer` and is never parsed.
  - curl gets `--max-filesize`.

## Verification

1. Run `./equin test` on the touched plugins.
2. Run `./equin build`.
3. Have a security-focused review subagent (Sonnet) check the merge-base diff.
4. Push.

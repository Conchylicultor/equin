# Supervisor event streams

Task: task-1794617646-v1stvf. Prototype: proto-1794509585-7ca910 (views `events`, `routing`, `event-session`).

## Context

Supervisor roles (`tasks/supervisor-roles`) only learn about work from their backlog. The user wants generic
events — first **error reports** and **slow-op (perf) reports**, later the health report and slow builds — routed to
a role's **live session**, split so errors and perf can go to different supervisors, without storms flooding the agent.

Design decided in the prototype:

- **Streams**: a stream is a named, generic event source. Each stream goes to **at most one** supervisor (or nobody),
  optionally filtered to some of its kinds.
- **Spacing, not a cap**: the first event after a quiet period goes to the session **at once**; that starts a quiet
  period of N minutes ("Space messages", default 10). Everything that lands in it is gathered and sent as **one**
  message when it ends, which starts the next period.
- **Always summarized**: a message is one line per report — `×count kind · title` (+ report id) — never the full report.
- **No live session**: `drop` (default) | `backlog` (file one backlog task with the summary) | `launch` (launch a
  session whose first turn carries the summary).
- UI: an **Events** section on a role's page (streams + Add a stream, kinds filter, the two settings, a pending banner
  with Send now, a message log DataView with outcome); an **Event routing** table on All supervisors.

## Design

### 1. Reports: a category per kind, and a multi-listener recorded signal (`plugins/reports`)

- `ReportKindSpec.meta.category: ReportCategory` — **required** (`"error" | "slow-op"`, declared in `reports/core`).
  Every kind states which it is (tsc enforces it). The report streams read it; no consumer names a kind.
- `reportRecordedSignal` is a one-handler sink already taken by the investigations automation. Replace it with a
  multi-listener server contribution `ReportRecorded({ id, onRecorded(reportId) })` (`defineServerContribution`);
  the engine calls every contribution where it emitted the signal. `reports-investigation` contributes its wake.

### 2. `tasks/supervisor-roles/plugins/events` (new) — the generic engine

- `core`: `SupervisorEventStream` descriptor type, settings/route/message schemas, endpoints, live declarations:
  - `supervisor-events.streams` (live value, served from `SupervisorEventStream` contributions: id, label, icon,
    description, kinds),
  - `supervisor-events.routes` (all, ≤ 50), `supervisor-events.settings` (by role),
  - `supervisor-events.pending` (by role, ≤ 200), `supervisor-events.messages` (by role, newest first, limit 50).
- `server`:
  - Tables: `supervisor_event_routes` (stream_id PK → role_id FK cascade, kinds jsonb null),
    `supervisor_event_settings` (role_id PK FK cascade, gap_minutes default 10, idle default `drop`),
    `supervisor_event_pending` (role_id, stream_id, key PK; kind, title, ref, count, first_at, last_at),
    `supervisor_event_messages` (id, role_id, sent_at, events, reports jsonb, outcome `sent|dropped|filed|launched`,
    task_id, conversation_id; pruned to 50 per role).
  - `SupervisorEventStream` server contribution: `{ id, label, icon, description, kinds(): string[] }`.
  - `publishSupervisorEvent({ stream, key, kind, title, ref })`: route lookup + kinds filter → upsert pending (role
    advisory lock) → if the role's last message is older than its gap, flush now; else enqueue the keyed flush job
    `supervisor-events.flush` (dedup by role) at `lastSentAt + gap`.
  - Flush (job + `POST /api/supervisor-roles/:id/events/flush` "Send now"): take the role's pending rows, render the
    summary, then: live session with a conversation → `submitTurn(conv, { kind: "event" })` (`sent`); live session
    not started yet → keep pending, retry at +gap; no live session → idle policy (`dropped` / backlog task via the
    roles' backlog filing / `launched` via the sessions plugin's launch with the summary appended to the first turn).
    One `messages` row per flush.
  - Endpoints: `PUT /api/supervisor-events/streams/:streamId` `{ roleId | null, kinds | null }` (one owner per stream:
    PK), `PATCH /api/supervisor-roles/:id/events` `{ gapMinutes?, idle? }`.
- `web`: `RoleEventsSection` (role page) and `EventRoutingSection` (All supervisors), rendered by the pane.

### 3. `events/plugins/report-streams` (new) — the first two streams

Contributes streams `errors` ("Error reports", kinds = report kinds with category `error`) and `slow-ops`
("Slow-op reports", category `slow-op`), and a `ReportRecorded` listener that enqueues a job which reads the report
and calls `publishSupervisorEvent({ stream, key: fingerprint, kind, title: message, ref: report id })`.

### 4. Pane

`role-detail.tsx` renders `<RoleEventsSection>` between the settings card and the backlog; `shared-detail.tsx` renders
`<EventRoutingSection>`. Prototype gives the look (stream rows, two `SettingRow`s, pending banner, message DataView).

## Out of scope (follow-ups)

- "Mute that report" from the banner; health-report and slow-build streams (marked *Soon* in the prototype).

## Verification

- `./equin test` for the spacing logic (pure decision function: first instant, gathered within gap, idle policies).
- `./equin build`, then on the worktree: route Error reports to a role, launch its session, record a few reports
  (e.g. via the reports endpoint) → first arrives as an event turn at once, the rest as one message after the gap;
  check the message log, Send now, and `drop` with no session. Screenshot the pane against the prototype.

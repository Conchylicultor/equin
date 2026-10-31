# A slow-op burst is one incident, not one fingerprint

Follow-up of task-1793316427-xlxoqr (the independent audit's risk #3). Revisits
point (4) of `2026-10-30-global-slow-op-one-cause-one-report.md`.

## Problem

258d21d482 filed a client batch's 2+ distinct slow ops of one kind as ONE
report, fingerprint `slow-op:<kind>:burst`. That fixed the notification fan-out
(14 `update`s at once → 14 bells) by merging report identity, which is the
wrong axis:

- **Unrelated incidents share a row.** Every burst of a kind, whatever its
  cause, lands on the same `slow-op:update:burst` report. Its count, `recent`,
  payload and investigation describe whichever burst came last.
- **A co-occurring op is invisible.** An op that only ever trips beside others
  never gets a report row of its own, so it is never investigated and never
  notified. Its `slow_ops` row exists, but nothing alerts on it. A new slow op
  inside a known burst raises nothing new: the burst row just bumps its count.

Collapsing one incident into one alert is right. Collapsing it into one
**identity** is not.

## Design: identity per op, alert per incident

Two axes, owned by two layers:

1. **Report identity stays per op.** `slow-op:<kind>:<operation>`, as before
   the burst change. Every member of a burst files its own report: its own
   count, its own history, its own Investigate button. Each payload carries
   `burst` (the batch's count and its slowest few ops, named), so an
   investigation sees what tripped with it. Reports pane rows are exact.
2. **The bell rings once per incident** — a new generic engine entry point,
   `recordReportIncident(inputs)` (reports/engine). Each input goes through
   exactly the `recordReport` row path: shed, fan-out, velocity and upsert,
   each on its own fingerprint. Then ONE notification is written for the
   incident instead of one per row. It rings for:
   - the first member whose row is **new** (count 1, never seen in this
     worktree) when there is one, so a new op always surfaces, keyed by its
     own report (a fresh dedupe key: always unread);
   - otherwise the **lead** (the first input that would ring; callers order
     most significant first — slow-ops passes slowest first).

   The description says how many reports came with it (`+N related, M new`).
   Its metadata lists every member report id. A member that would not ring
   alone (rate-limited, collapsed, shed) is not counted as ringing. A shed
   member replays later through `recordReport` and rings alone, as any shed
   report does.

The engine owns "an incident rings once", so any other kind with a co-occurrence
signal gets it for free. Slow-ops only says which reports are one incident: a
batch's items of one kind, as before (`reportsFor` → incidents).

## What changes

- `reports/engine`: `fileReport` (the row path, returns the result plus the
  bell it would ring) split out of `recordReport`; `recordReport` = file + ring;
  `recordReportIncident` = file each + `pickIncidentBell` (pure) + one ring.
- `debug/slow-ops`: `reportsFor` → `incidentsFor`, one incident per kind, one
  report per distinct op (its slowest trip). Each member carries `burst`
  when the incident has more than one. `BURST_OPERATION` is gone; the renderer
  keeps a legacy branch for existing `operation: "burst"` rows.
- Fan-out stays per fingerprint. A batch with more distinct ops than the kind's
  window budget (20) folds the rest into the `report-storm` rollup, as any storm
  does. Rows still exist in `slow_ops`.

## Tests

- `pickIncidentBell`: lead when none new; the first new member wins over the
  lead; non-ringing members are skipped; nothing rings → null.
- `incidentsFor`: one incident per kind, one report per distinct op,
  slowest first, `burst` on every member iff 2+, its named cap.

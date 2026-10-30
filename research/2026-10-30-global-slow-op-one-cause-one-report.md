# One slowness cause, one slow-op report

Task: task-1793316427-xlxoqr (from the 2026-10-29 audit of main's slow-op reports).
Builds on `2026-10-30-global-slow-op-own-time.md` (every item judged on `ownMs`,
gate queues filed once as `wait <layer>`).

## Context — re-measured on main after own-time landed

Main booted with own-time at 13:55Z (2026-10-30). In the next 30 min,
`slow-op-markers.jsonl` still shows one cause filed as many fingerprints:

- **13:57:21** — one `edited-files` loader (2.66 s) filed **14** fingerprints:
  `bg watch-edited-files:pass`, `loader edited-files` + `:meta`,
  `push edited-files` + `:meta`, `flush flushNotifies`, `push deliver:` ×4
  (including the innocent `notifications` / `notifications.unread`), and
  `update` ×4 for the same resources on the client.
- **14:02:30 / 14:24:20** — one `conversations.context-usage` loader (2.3–2.9 s)
  → loader + push + flush + `deliver:conversations.context-usage` +
  `deliver:queue-health.pulse` (victim) + client `update queue-health.pulse`
  (3.4–3.9 s, nearly all `server-deliver`).
- **14:14:24 / 14:15:10** — 14–18 client `update`s for unrelated resources in
  the same batch (one trace), one fingerprint each.
- **14:08:50** — 8 `element`s in the same ms (one page boot).

Own-time already removed the gate-queue bursts (22:31 `sub` storm). What is left:
(1) an op filed again by every span that encloses it, (2) deliveries that merely
waited for it, (3) the client re-filing the server window the server already
judged, (4) a client batch's burst filed per resource, (5) warm-ups judged by two
monitors.

## The rule

**A slowness is filed once, by the op that owns it. Every other measurement that
contains it takes it off its own time, keeps it as a named layer in `waits`,
and is judged on what remains.** This is the own-time rule extended from "a gate's
queue" to "an op already filed".

## Pieces

### 1. Profiler: a filed span claims its interval (`runtime-profiler/core/recorder.ts`)

- `SlowSpanHandler` returns `boolean`: true = "I filed this span as its own slow
  op". If any subscriber files it, the recorder **claims** the span's
  `[end − duration, end]` on every open enclosing entry (the same walk as
  `chargeWait`), on a per-claimant track named `<kind> <label>`.
- `EntryContext` gains `excludedUnion` (gate waits ∪ claims — `chargeWait`
  contributes too), `claimUnions` (per claimant) and positioned `claimBands`
  (bounded, `pushBand`).
- `SlowSpan` gains `excludedMs` (that union) and `claims` (per claimant).
  slow-ops' `slowSpanMs = durationMs − excludedMs`. So `push edited-files`,
  `flush`, `bg …:pass`, an `http`/`sub` around a slow loader, a loader around a
  slow `db` query: all judged net of the filed child — the innermost slow op is
  the one report, its ancestors only if they were slow on top of it.
- A **latency leaf** — `recordSpan(…, { latency: true, waits })` — is a window
  spent waiting on the enclosing entry's work, not work of its own. It is judged
  net of the claims its enclosing entry collected inside its window (and of its
  own `waits`).

### 2. Deliveries are latency leaves (`resource-runtime`, `server-core`)

- `ResourceDelivery` gains `holdMs` (the declared throttle hold, already on
  `PendingNotify`).
- `onDelivered` records `deliver:<key>` with `{ latency: true, waits:
  { "throttle-hold": holdMs } }`: a delivery that only waited for another
  resource's slow load in the same flush is not filed; one slow for no filed
  reason still is (it remains the end-to-end server latency measure). Held to `updateMs` (1000), not `loaderMs`
  (2000): it replaces the client half that no longer counts this window.

### 3. The client does not re-file the server's window (`perfs/latency-signal`)

`HELD_PHASES` becomes `EXCLUDED_PHASES`, each excluded phase with its owner:
`throttle-hold: "declared"`, `server-deliver: "server"` (exactly the window the
server's `deliver:<key>` span judges: first notify → send, less the hold).
`ownMsOf` is unchanged in shape. An update is judged on `server-notice +
transport + client-apply`. `element` has no server split on the wire — left as is
(sidequest).

### 4. A batch's burst is one report (`slow-ops/server`)

`recordSlowOpBatch` keeps one row per op (aggregates unchanged), but files reports
per **(batch, operationKind)**: one item → its own report (today); two or more →
ONE report, operation `burst`, fingerprint `slow-op:<kind>:burst`, payload
`burst: { count, operations (slowest 10 with own ms) }`, waits summed. A client
batch is one tab's 250 ms window; same-kind items in it share a cause (the tab,
its socket, its boot) — the trace was already shared per (batch, kind). Server
spans arrive one per batch, so they are unaffected.

### 5. A warm-up is judged once (`infra/warmup`, `debug/boot-budget`)

The warm-up's `bg` span (slow-ops: own time, claims, trace, callers) is the one
judge. The executor stamps `budgetMs: w.budgetMs ?? DEFAULT_WARMUP_BUDGET_MS`
(2000, boot-budget's old default) on it; boot-budget stops judging `warmup:`
spans and drops `warmupBudgetMs` (no user override exists on main). The
`warmup:` boot span stays for the Gantt.

## Verification

- `./equin test`: recorder (a filed child is excluded from its ancestors' own
  time; an unfiled one is not; a latency leaf is judged net of the claims inside
  its window), latency-signal `ownMsOf`, slow-ops burst grouping, boot-budget
  budget, warm-up drain.
- `./equin check`, `./equin build`.
- After landing: re-run the markers burst query on main — the 13:57:21 shape
  should be one `loader edited-files` (+ `:meta`) row per incident.

## Outcome (implemented 2026-10-30)

As planned, plus two review fixes:

- **A burst counts distinct operations**: one op tripping twice in a batch
  (two tuples of one resource) keeps its own fingerprint.
- **A latency leaf is judged on `updateMs`**, not `loaderMs`. The span carries
  `latency: true`, and `perfFloorMs` now includes `updateMs`. Without this, a
  1–2 s delivery would have been judged by nobody once the client stopped
  counting `server-deliver`.

# Crash reports: stackless errors must not merge, and a repeat must alert again

## Context

Two problems found while investigating a `worktree-cleanup.reap-stale` failure on 2026-09-12.

**1. Unrelated errors land on one report row.** A crash report's identity is
`sha256(errorType + top 3 stack frames)` (`plugins/reports/plugins/crash/core/crash-kind.ts`).
When an error arrives with no error type *and* no parsable stack, that input is the constant
string `Error|`, so every such error hashes to `fd09132174a7869f` and upserts onto the same
`(fingerprint, worktree)` row. On main that row (`crash-1778578729737-j7mmbv`) has swallowed 499
unrelated occurrences since 2026-05-12: it is still labelled `browser-error`, still linked to a
task from May, and its message is whatever arrived last — on 2026-09-12 a jobs stuck-lock sweeper
line. Anyone reading it sees the wrong source, the wrong task and the wrong history.

Who produces stackless reports today: browser `window.onerror` events with no `Error` object
(`ResizeObserver loop completed with undelivered notifications.` is the current occupant of that
row), and server call sites that pass `stack: null` — the three jobs stuck-lock sweeper messages
(`plugins/infra/plugins/jobs/server/internal/stuck-lock-sweeper.ts:190,228,277`), `job-lock.ts:175`,
and a few more.

Note the shape that must keep working: several callers deliberately pass **no stack but a stable
`errorType`** so a family of varying messages collapses onto one row — `PaneRestoreCorrupt`,
`JobDeadline`, `LiveStateWedge:<discriminator>`, `PluginLoadError <path>`, `EndpointError <status>
<route>`. Those are caller-declared identities and must not change.

**2. A crash that happens again never alerts again.** The bell row for that report was dismissed
around 2026-09-08 and has been hit 33 times since; each hit only bumped its count. The cause is a
default, not a decision: `ReportKindSpec.meta.notifCooldownMs` is optional, and omitting it means
`recordNotification` gets no `resurfaceAfterMs`, i.e. *never re-surface*
(`plugins/reports/server/internal/record-report.ts`,
`plugins/shell/plugins/notifications/server/internal/record-notification.ts`). Roughly half of the
~38 report kinds — crash included — omit it and are therefore silently one-shot.

There is no report kind for which "never tell me again" is the right answer: a report **is** a
problem, and a problem that recurs after you dismissed it is news. So the fix is to remove the
spelling for "never" rather than to add a setting.

Outcome wanted: one report per distinct problem (never a catch-all bucket), and a recurrence of a
dismissed problem alerts again, at most once per cooldown.

## Part 1 — an identity that cannot collapse to a constant

### The fingerprint gets the message

`ReportKindSpec.fingerprint` currently only sees the kind's `data` payload, which for a stackless
crash carries no identity at all. Widen it in `plugins/reports/server/internal/report-kinds.ts`:

```ts
export interface ReportFingerprintContext {
  /** The report's raw one-line message, pre-clamp. */
  message: string;
  /** The reporting channel ("browser-error", "server-caught", …). */
  source: string;
}

fingerprint(data: TData, ctx: ReportFingerprintContext): Promise<string> | string;
```

`recordReport` passes `{ message: rawMessage ?? "", source }` at the existing
`await spec.fingerprint(parsed)` call site. Existing implementations that ignore the second
argument (`renderLoopFingerprint`, every inline one) keep compiling untouched.

### The crash fingerprint's three-branch rule

In `crash-kind.ts`, `crashFingerprint(data, ctx)` picks its identity material in this order, so
every existing report keeps its current fingerprint and only the degenerate case changes:

1. **Parsable frames** → `${errorType ?? "Error"}|${top3Frames}` — today's rule, unchanged.
2. **No frames but an `errorType`** → `${errorType}|` — today's value for the caller-declared
   identities listed above, unchanged.
3. **Neither** → `Error|msg:${normalizeMessage(ctx.message)}` — new. The message is the only
   identity such a report has, so it becomes the identity.

`normalizeMessage` (exported for the test) collapses whitespace, replaces the volatile tokens that
would otherwise mint a row per occurrence, and truncates to 200 chars:
slug ids (`conv-1789653369-gpuv`, `task-…`, `att-…`) → `<id>`, UUIDs → `<uuid>`, hex runs ≥ 8 →
`<hex>`, digit runs → `#`. So the three sweeper messages become three stable rows keyed by
`[jobs] reclaimed serialization queue "<name>" …` rather than one bucket, and `(job 12345)` does
not mint a row per job.

Also extend `normalizeFrames` to accept the non-V8 stack form (`fn@https://host/file.js:12:3`)
alongside `at …`, so a Safari/Firefox stack is frames rather than nothing.

The reports engine's own guards cover the risk this adds (a message with a volatile token nothing
normalizes minting many rows): the per-kind cross-fingerprint fan-out ceiling
(`fan-out.ts`) folds a distinct-fingerprint burst into one `report-storm` rollup, and the 7-day
retention sweep reclaims untouched rows.

### Not in scope, worth a follow-up task

The jobs stuck-lock sweeper lines are not crashes — they are operational notices filed through
`reportServerError`, which hard-codes `kind: "crash"`. They would read better as their own report
kind. File a task rather than widening this change.

## Part 2 — no spelling for "never re-alert"

Keep `meta.notifCooldownMs` optional, but make the engine treat it the way `meta.fanOutPerWindow`
is already treated: **only ever a raise above an engine floor**, with no way to express "off".

In `plugins/reports/server/internal/record-report.ts`:

```ts
// Every report is a problem, and a problem that recurs after you dismissed it is
// news — so a kind cannot opt out of re-alerting, only ask for a longer quiet
// window. Same shape as meta.fanOutPerWindow: there is no spelling for "never".
const RENOTIFY_FLOOR_MS = 10 * 60 * 1000;
…
resurfaceAfterMs: Math.max(RENOTIFY_FLOOR_MS, spec.meta.notifCooldownMs ?? 0),
```

What this changes, per kind:

- Kinds that omit it (crash and ~half the others) go from *never* to *at most one alert per
  10 minutes*. A crash you dismissed comes back as a fresh unread bell row (and one toast) the
  next time it fires, 10 minutes or more after it last surfaced.
- Kinds that set 6 h / 24 h keep their value.
- `slow-op`'s 60 s becomes 10 minutes — quieter, which is the right direction for the noisiest kind
  in the table (its rollup fingerprint has 420 k occurrences).

The existing throttles keep this from becoming spam: the per-fingerprint velocity window
(`velocity.ts`, >20/min) skips the bell entirely during a burst, a still-unread row re-surfacing
only floats to the top without a toast (the bell toasts on a *newly appearing* id,
`bell-button.tsx`), and `noise`-classified reports stay muted.

Update the `ReportKindSpec.meta.notifCooldownMs` doc comment (its "omit for kinds that should never
resurface — e.g. crash" clause is now exactly wrong), the paragraph above `recordNotification` in
`record-report.ts`, and the `notifCooldownMs` mentions in the kind `CLAUDE.md` files
(`plugins/debug/plugins/queue-health`, `op-rate`, `plugins/reports/plugins/{turn-unconfirmed,
adaptive-bar,live-state-stale-drop,optimistic-divergence,viewport-escape}`).

`recordNotification`'s own `resurfaceAfterMs` stays optional — its non-report callers
(`conversation-created`, `build-finish`, page reminders) dedupe on keys that are unique per event,
where re-surfacing is meaningless.

## The existing polluted row

Once this lands, `fd09132174a7869f` receives nothing further (its occupants now fingerprint by
message). It keeps its 499 historical occurrences and its May task link; it has a `task_id`, so the
7-day retention sweep will not reclaim it. Leaving it is the honest outcome — it is a real record of
what was collected — and no code path reads it. No migration, no backfill: re-fingerprinting old
rows would need the original messages, which the row does not keep (only the last one).

## Files

- `plugins/reports/plugins/crash/core/crash-kind.ts` — three-branch fingerprint, `normalizeMessage`,
  wider `normalizeFrames`.
- `plugins/reports/server/internal/report-kinds.ts` — `ReportFingerprintContext`, wider
  `fingerprint` signature, corrected `notifCooldownMs` doc.
- `plugins/reports/server/internal/record-report.ts` — pass the context, `RENOTIFY_FLOOR_MS`.
- `plugins/reports/plugins/crash/CLAUDE.md`, `plugins/reports/CLAUDE.md` + the kind `CLAUDE.md`s
  listed above — prose.

## Verification

1. `./equin test plugins/reports` — new `crash-kind.test.ts` (pure, next to the source):
   - two different stackless, typeless messages → different fingerprints (the regression);
   - the same message with different job ids / conversation ids / numbers → one fingerprint;
   - a stack with frames, and a stackless report with an `errorType`, still produce the exact
     fingerprints they produce today (pin the literal hashes so the migration-free claim is
     enforced, e.g. `LiveStateWedge:missed-updates`);
   - a Safari-form stack yields frames.
   Extend the DB-backed `record-report.test.ts` (it already drives `upsertReport` against a
   throwaway Postgres via `createTestDb`) with: two stackless messages → two rows, not one.
2. `./equin build` (background, end the turn), then check the deploy receipt at
   `~/.singularity/worktrees/<worktree>/build-status.json`.
3. Re-alerting, end to end on this worktree: use `query_db` to confirm the crash bell row for a
   fingerprint, dismiss it in the app, trigger the same crash again (a `ResizeObserver` loop or any
   stackless browser error from the console), and confirm with `query_db` that the notification row
   went back to `read = false, dismissed = false` with a bumped `count` — and that an immediate
   second hit inside 10 minutes only bumps the count.
4. `query_db` on this worktree's `reports` after exercising the jobs sweeper path (or by replaying
   its three messages through `recordReport`): three distinct fingerprints, not one.

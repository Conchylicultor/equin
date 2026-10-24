# Op profiles account for machine sleep

## Context

On 2026-10-08 a push op (`4e75a893…`, conv-1791412761-o87e) ran 5h14 of wall
time. It queued 56 min on the push mutex, ran checks for about 15 min, and then the
laptop slept with the lid closed for 3h40 in the middle of `type-check`. Every surface
showed it as "pushing for 4 hours" with no hint that the machine had been asleep.

Two defects:

1. **Sleep is invisible.** Nothing in the op log, the op detail, the Gantt or the
   op-status banner tells a nap apart from work.
2. **The fold mixes clocks.** Event `t` comes from `performance.now()`, which pauses
   during sleep, while `at`, `totalMs`, `holdMs` and the live tail are wall clock.
   After a sleep the wait overlays sit too early inside a bar that is too long, and
   `workingMs` (wall total − t-based waits) counts the sleep as work.

**Outcome:** each op carries exact sleep intervals. The Gantt stays on the wall-clock
axis and draws sleep as a hatched **Asleep** block. Op detail shows Wait / Work /
Asleep / Total, and the four always reconcile. The banner tooltip shows how long the
op was asleep, and the banner's expanded table gains an Asleep column that is hidden
by default. "Worked" never counts sleep.

## Mechanism

macOS has two raw clocks. `CLOCK_MONOTONIC_RAW` keeps running through sleep;
`CLOCK_UPTIME_RAW` pauses. Their difference is the **cumulative time asleep since
boot**, a value shared by the whole machine that any process can read. Sleep between
two stamps from the same boot is their difference, exactly.

`sysctl kern.bootsessionuuid` identifies the boot. `kern.waketime` gives the instant of
the last wake, which places the most recent sleep exactly. Both were verified on this
machine: `kern.waketime` read 23:09:04, the lid-open wake in `pmset`.

## Fixed interfaces (land first; chunks build against them)

```ts
// packages/sleep-clock/core  (node-only, bun:ffi)
export type SleepClockReading =
  | { supported: true; boot: string; asleepMs: number; wakeAtMs: number | null }
  | { supported: false };
export function readSleepClock(): SleepClockReading;
// createSleepMeter() is reimplemented on top of readSleepClock(); its behaviour is unchanged.

// op-log/core types.ts  (all new fields optional: old CLIs and old log tails still fold)
export interface SleepStamp { boot: string; asleepMs: number; wakeAtMs?: number }
// every non-terminal OpEvent gains:  sleep?: SleepStamp
export interface OpSleep { startMs: number; durationMs: number; approx: boolean } // wall offset from requestedAt
// OpWait gains:  atMs?: number; wallMs?: number   (wall axis; startMs/durationMs stay t-based)
// OpSummary gains:  sleeps?: OpSleep[]
// OpFoldState gains:  sleeps: OpSleep[]; sleepStamp: { boot; asleepMs; atMs } | null
// OpRecord gains:  sleeps: OpSleep[]; asleepMs: number
// OpLiveTimes gains:  asleepMs   (identity: waitingMs + workingMs + asleepMs === elapsedMs)
export type SleepNow = { boot: string; asleepMs: number; wakeAtMs: number | null } | null;
// toOpRecord(s, now, sleepNow) / liveTimes(s, now, sleepNow) / reconcilerCompletedEvent(s, now, sleepNow)
//   sleepNow is a REQUIRED parameter (null = unknown) so no call site silently omits it.
```

## Design

### 1. Sleep source: `packages/sleep-clock`

- Add `readSleepClock()`.
  - `asleepMs` = (MONOTONIC_RAW − UPTIME_RAW) in ms.
  - `boot` = `sysctlbyname("kern.bootsessionuuid")`.
  - `wakeAtMs` = `kern.waketime` (`struct timeval`). Use `null` when the value is 0 or unreadable.
  - Read through the same lazy `dlopen` of libSystem.
- Off darwin, return `{ supported: false }`. That means "cannot tell", never "did not sleep".

### 2. Writer: `op-log/server/internal/profiler.ts`

- `emit()` stamps `sleep` on every event, `requested` included, when the reading is supported.
  - The reader is injected (an `opts.readSleep` option, defaulting to `readSleepClock`) so tests can drive it.
- The profiler keeps its own running sleep fold, through the **same pure function** the fold uses (`advanceSleeps` exported from `core/fold.ts`).
  - `write()` puts `sleeps` into `OpSummary`.
  - `write()` adds the wall fields `atMs`/`wallMs` to every wait.
- **One clock for steps.**
  - `recordStep` currently takes a `performance.now()` start; `stepStart`/`stepEnd` use wall offsets.
  - Make `recordStep` wall-based. Convert at the call site (`cli/check/cli/run.ts` passes perf), or take a wall start.
- `totalMs` and `holdMs` stay wall clock.

### 3. Fold: `op-log/core/internal/fold.ts` (pure)

**Stamp handling.** On each non-terminal event that carries `sleep`:

- **Same boot as the previous stamp and `asleepMs` grew by `delta`:** append an `OpSleep` for `delta`, then store the new stamp `{ boot, asleepMs, atMs }`.
  - **Exact placement:** if `wakeAtMs` falls inside the gap, the block is `[wakeAtMs − delta, wakeAtMs]`, clamped to the gap, with `approx: false`.
  - **Fallback placement:** otherwise the block sits at the end of the gap with `approx: true`. A wake is what usually unblocks the next event.
- **Different boot, or no previous stamp:** add no interval and just reset the stamp. Never invent sleep across a reboot.

**Other cases:**

- **Event without `sleep`** (legacy line or unsupported platform): leave the stamp untouched. Such ops fold exactly as they do today, with `sleeps: []` and `asleepMs: 0`.
- **`wait-end`:** derive `atMs = openWait.startedAt − requestedAt` and `wallMs = ev.at − openWait.startedAt`.
- **`completed`:** the summary's `sleeps` is authoritative, because the writer saw every event. Fall back to the folded `s.sleeps`.
- **Merging:** merge overlapping sleeps (darkwake naps inside one gap become one block, `approx` if any part is) and clip them to `[0, total]`.
- **Totals:**
  - `asleep` = the union of sleeps.
  - `waiting` = the wall extent of the waits minus their overlap with sleeps, so sleep during a wait counts as asleep.
  - `working` = total − waiting − asleep, clamped at 0.
  - These are computed in **one** helper used by both `toOpRecord` and `liveTimes`, so the identity holds by construction.
- **Live tail:** when `sleepNow` has the same boot and `asleepMs > stamp.asleepMs`, derive a tail sleep.
  - It ends at `sleepNow.wakeAtMs ?? now` and starts at end − delta, clamped to at least `stamp.atMs`.
  - It is derived on every render and never stored.
  - The open wait is clipped by sleeps the same way.
- **Waits without wall fields** (legacy lines): place them by `startMs` as today.

### 4. Live "now" reading: new plugin `infra/host/plugins/machine-sleep`

The browser cannot use FFI, and a sleeping op's last event can be hours old, so a server pushes the current reading.

- **`core`:** declares `liveValue("machine.sleep")`, holding `SleepNow` (`null` = unsupported).
- **`server`:**
  - `serveValue` serves the value.
  - `publishSleepReading()` sets the value only if it changed. It changes only when the machine wakes, so it pushes only then.
- **`web`:** `useSleepNow()` returns a loading state until the first value, per the "not-known-yet" rule. It does not return `null`.
- **Signal:** the health-monitor `process-sampler` already ticks every 10 s and already reads a sleep meter.
  - It calls `publishSleepReading()` on each tick. No new poller is added.
  - A comment at the call site documents that the existing observer is reused.
  - Latency is ≤10 s after wake.
- **Dependencies:**
  - machine-sleep depends on sleep-clock.
  - op-status and profiling/ops depend on `machine-sleep/web`.
  - health-monitor depends on `machine-sleep/server`.
  - No cycle. op-log core stays free of it, because the reading is passed in as `sleepNow`.
- **Reconciler** (`op-store/server/internal/reconcile.ts`): calls `readSleepClock()` directly. The closing event carries its stamp, and that stamp closes the tail.

### 5. Persistence: op-store

- Add two columns to `op_log_ops`:
  - `sleeps jsonb not null default '[]'`.
  - `sleep_stamp jsonb` (nullable).
- Update `tables.ts` (and its `touchedBy` map), `core/internal/schemas.ts` (`OpRowSchema` and `opRowToFoldState`, with defaults for old rows) and `store.ts` (`stateToRow`).
- The wall fields of a wait live inside the existing `waits` jsonb.
- `./equin build` generates the migration.
- `stats/plugins/pushes` reads `closed_wait_ms` and `steps`; it does not read `total − wait`. Leave it unchanged, but verify.

### 6. UI

**Shared hatch:**
- Promote the `DARK_HATCH` look from `plugins/debug/plugins/timeline/web/components/gantt-rows.tsx` (the gradient plus `text-muted-foreground/60`) to one export in `profiling/web`, beside `multi-span-lane.tsx`.
- The timeline re-imports it from there. Check for a web cycle; if there is one, find the lowest common owner.
- `SpanBar.overlays` gains an optional style or variant so an overlay can render hatched.

**Op detail** (`ops/web/components/op-detail.tsx`):
- The Stat grid becomes Wait / Work / Asleep / Total. Show Asleep only when `asleepMs > 0`.
- `OpTimeline` adds the Asleep overlays and places waits by `atMs`/`wallMs` when they are present.
- The tooltip reads "Asleep 3h40" for an exact block and "Asleep 3h40 (position approximate)" for an approximate one.
- Live ops pass `useSleepNow()`.

**Op Gantt** (`op-gantt/web/components/op-gantt.tsx`):
- `OpBar` draws the hatched Asleep overlays.
- `OpLegend` gets an "Asleep" entry when present.
- `SpanDetail` shows the label.

**`ops/web/internal/op-groups.ts`:** thread `sleepNow`, and exclude asleep time from work.

**Op-status banner and chip** (`conversations/.../op-status/web`):
- `timesOf` takes `useSleepNow()`.
- The row tooltip reads "waited … · worked … · asleep …", with the asleep part only when > 0.
- `queueFields` gains `asleep`, with `visible: false` (the mechanism already used by `section`). Verify the column picker can reveal it.

## Implementation split (Opus agents)

| Chunk | Scope | Depends on |
|---|---|---|
| **A: source** | `readSleepClock` (+ tests); `infra/host/plugins/machine-sleep` (core/server/web, set-if-changed test); process-sampler hook; reconciler stamp | interfaces only |
| **B: model** | types, fold (`advanceSleeps`, totals helper, tail), profiler (stamps, summary, step clock), op-store columns/schemas/store; fold-v2 / profiler / ingest tests | interfaces only (`readSleep` injected) |
| **C: UI** | hatch promotion, op-detail, op-gantt, op-groups, banner/chip/column, e2e | B's types + A's `useSleepNow` |

A and B run in parallel. C starts once both have landed their exported signatures, because C would otherwise duplicate type work. Then one `./equin build` and verification.

## Verification

1. **Unit tests**, with `./equin test` on `plugins/packages/plugins/sleep-clock`, `plugins/debug/plugins/profiling/plugins/op-log` and `plugins/debug/plugins/profiling/plugins/ops`.
   - `fold-v2.test.ts`: `ev()` gains `{ at, t, sleep }` overrides so the clocks can diverge. It must cover these cases:
     - exact and approximate placement
     - boot change
     - legacy line
     - sleep inside a wait
     - tail with and without `sleepNow`
     - re-ingest no-op
     - reconciler close
     - the property that Wait + Work + Asleep == Total over random interleavings
   - `profiler.test.ts`: a fake `readSleep` produces stamps on every event, `sleeps` in the summary, and one step clock.
   - `ingest.test.ts`: the new columns round-trip, and old rows get defaults.
2. **`./equin build`** (migration plus checks).
3. **E2E:** extend `op-status/scripts/synthetic-op.ts` to write events whose stamps carry a synthetic sleep gap (+N ms asleep, `wakeAtMs` inside the gap). Add `op-status/e2e/op-sleep.ts`. It asserts three things:
   - The op detail shows the Asleep stat with the right value and a hatched overlay.
   - The banner tooltip's "worked" excludes the sleep.
   - The Asleep column is hidden by default and can be revealed.
4. **Real data:** after deploy, open the incident op and any op that spans a nap on `http://<worktree>.localhost:9000`. Old ops render unchanged. New ops show their naps.

## Risks

- Several sleeps in one gap merge into one approximate block. Darkwake cycles make this common for long lid-closed sleeps, but the total is still exact.
- After a wake, a live op shows the sleep as work for up to 10 s, until the sampler tick publishes the new reading.
- `kern.waketime` covers only the last wake. Earlier sleeps in the same gap fall back to the approximate end-of-gap placement.

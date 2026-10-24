# Machine watcher row shows what the watcher measures

## Context

The health report's **Machine watcher** row says only "Running since 5:44 PM".
The watcher (the cluster sentinel worker) samples the whole machine every 5 s,
but none of that reaches the browser: samples go only into main's `cluster`
trace ring. The user asked to see the stats, and approved a mock:
**proto-1789664064-nr56** ("Machine watcher stats").

What the approved mock shows:

- **Summary** (always computed, colours the dot): unchanged, except while the
  machine is under duress — red, "Under duress since 6:02 PM · builds held back".
- **Glance** (under the summary, popover open): `Load 0.26 per core · 9.4 GB free · 1 build`,
  plus a red banner "Tripped by load and memory compression" while under duress.
- **Expanded detail**: one line per signal that can trip duress, each with a bar
  toward its limit and the words "X of LIMIT", amber past ⅔ of the limit, red
  at it:
  - Load per core · Memory compression · Waiting database locks · Database disk reads · Slow worktrees
  - then one sentence: `11 worktrees running · Updated 3s ago`.
- **Stale** (no new reading for a while): numbers grey out, a note says how old they are.

## Design

### 1. The worker writes a host-global vitals file every tick

The status already reaches every worktree through a host-global file
(`locks/sentinel/status.json`) that every backend watches and serves. The
latest reading takes the same path, as a second file in the same directory:
`locks/sentinel/vitals.json`.

**The worker writes it, not main.** The worker is the thread that keeps ticking
while main is wedged, and it owns the detector — so the file carries the exact
readings, limits and trip state the detector acted on. A wedged main then
cannot make the row lie; a dead worker makes the file stop changing, which the
row shows as stale.

In `server/internal/worker/entry.ts` `processSample`, after `detector.feed`:
compute the readings and write the record (write-then-rename). A failed write
is logged through `log()` and never fails the tick — same rule as the
gatherers.

Record shape (zod, in the `status-file` leaf next to `SentinelStatusRecordSchema`,
since that leaf owns this directory's file shapes and is already lean enough for
the worker to import):

```ts
SentinelVitalsRecordSchema = z.object({
  pid: z.number().int().positive(),       // main's pid (the worker's process)
  wall: z.number(),                        // sample wall clock
  cadenceMs: z.number(),
  signals: z.object({                      // one entry per detector signal, closed set
    loadRatio:            SignalSchema,    // { value: number | null, limit: number }
    decompressionsPerSec: SignalSchema,
    locksWaiting:         SignalSchema,
    blkReadDeltaMs:       SignalSchema,
    slowBackends:         SignalSchema,
  }),
  elevated: z.array(SignalKeySchema),     // signals at/above limit this tick
  tripped: z.boolean(),                   // detector.tripped after this tick
  context: z.object({
    freeMemMb: z.number().nullable(),
    inFlightBuilds: z.number().nullable(),
    runningBackends: z.number().nullable(),
  }),
})
```

- `signals` is keyed by the detector's own signal names. `detector.ts` exports
  its pure `signalsAt` (today private) so the worker reuses the exact math the
  trip decision used, and the limits come from the `thresholds` the worker
  already holds (`onLoadRatio`, `onDecompressionsPerSec`, `onLocksWaiting`,
  `onBlkReadDeltaMs`, `onSlowBackends`). No web-side config read, so a
  worktree whose config differs from main's cannot show the wrong limit.
- `SignalKeySchema` is a `z.enum` of the five keys; `detector.ts`'s `elevated`
  becomes typed with it (today `string[]`).
- A writer helper `writeSentinelVitals(dir, record)` and reader
  `readSentinelVitals(dir)` live in `status-file/server/internal/`, mirroring
  `createStatusWriter` / `readRecord` (`none` / `recorded` / `unreadable`).
- Stays within both lean checks (`sentinel:worker-closure-lean`,
  `sentinel:status-file-lean`): zod + node:fs + infra/paths only.

Cost: one ~500-byte write-then-rename every 5 s on one thread.

### 2. Every backend serves it as `sentinel.vitals`, watched, no polling

- **Descriptor** in `core/status.ts`: `sentinelVitalsResource =
  resourceDescriptor<SentinelVitals>("sentinel.vitals", …, { kind: "none" })`.
  Value: `none` | `unreadable {reason}` | `recorded {vitals, current: boolean}`.
  `current` is false when `vitals.pid` is not the pid in `status.json` (a hot
  restart's old worker, or a leftover file from a main that is gone), so a
  reading from the wrong process is never shown as live.
- **Server resource** in `server/internal/status-resource.ts`, push mode, next
  to `sentinelStatusServerResource`.
- **One watcher, routed by file name.** Today the watcher notifies the status
  resource on ANY `.json` change in the directory. With a vitals write every
  5 s that would reload and push the status to every tab every tick. Route
  each event by basename: `status.json` → status notify, `vitals.json` →
  vitals notify.

Push cost: one small message per 5 s, **only to tabs whose popover is open**
(see §4 — only the glance and detail subscribe).

### 3. Duress in the summary, without a 5 s stream

The summary (the dot's colour) runs on every tab all the time, so it must not
subscribe to the 5 s vitals. Instead the **status** resource also carries the
duress latch:

- `sentinel.status`'s loader adds `duress: { since: number } | null` from
  `readDuress()` (`infra/host/duress/latch`) gated by `isUnderDuress()`
  freshness. The value becomes `{ watch: SentinelWatch, duress }` (the
  descriptor lives in the parent sentinel core, so the leaf's `SentinelWatch`
  and the CLI's `duressGuard` are untouched).
- The status watcher also watches the latch directory (`duressLatchDir`):
  `setDuress` creates the file and `clearDuress` deletes it, so trip and clear
  each push once. The per-tick lease refresh (`utimesSync`) may or may not fire
  an event — harmless either way, the value is unchanged.
- A latch that lapses because the worker died needs no event: the worker's
  death already moves the status to `respawning` / `down`, which re-reads.

`machineWatcherVerdict` gains one branch: `running` + `duress !== null` →
`critical`, "Under duress since HH:MM · builds held back" (matches the mock's
red row; the report already sorts it to the top).

### 4. Web: glance + expandable detail on the existing row

The row contract already has both slots (`shell/health-report/core/types.ts`):
`glance` renders only while the report is open, `component` only while the row
is expanded. So the vitals subscription lives only there.

In `web/index.ts`'s `HealthReport.Row`, add `glance: MachineWatcherGlance` and
`component: MachineWatcherDetail`. New files under `web/`:

- `internal/vitals-view.ts` — pure: `SentinelVitals` + `now` → view model.
  Per signal `{ label, valueText, limitText, fraction, tone }` where tone is
  `bad` at ≥ limit, `warn` at ≥ ⅔, else neutral; `stale` when
  `now - wall > 3 × cadenceMs` or `!current`; the trip banner text from
  `elevated` when `tripped` ("Tripped by load and memory compression"). Labels
  and value formatting (`0.26`, `18k/s`, `1.2 s`) are a closed map keyed by
  `SignalKey`. A null value renders "—" with an empty bar.
- `components/machine-watcher-glance.tsx` — the three figures + banner. While
  vitals are loading: nothing (the summary already carries the verdict).
- `components/machine-watcher-detail.tsx` — the five signal lines, then
  "N worktrees running · Updated 3s ago" (`useNow` + `formatRelativeTime` from
  `primitives/relative-time`). Loading → `primitives/loading`; `none` /
  `unreadable` → one muted sentence saying so; stale → greyed with
  "No new reading since HH:MM".
- Layout from the `css` skill primitives (`Stack`, `Line`, `Text`); the bar is
  a small `SignalMeter` in this plugin unless `docs/plugins-details.md` already
  has a progress/meter primitive — search first. Five fixed signals are a
  closed set, not domain records, so no DataView.

Deliberately left out of the first cut: the "Open Timeline" link from the mock
(needs a navigable Timeline route to link to — follow-up).

## Files

- `plugins/debug/plugins/sentinel/plugins/status-file/core/internal/vitals.ts` (new) + core barrel export
- `plugins/debug/plugins/sentinel/plugins/status-file/server/internal/vitals-file.ts` (new) + server barrel export
- `plugins/debug/plugins/sentinel/server/internal/detector.ts` — export `signalsAt`, type `elevated` with `SignalKey`
- `plugins/debug/plugins/sentinel/server/internal/worker/entry.ts` — write vitals per tick
- `plugins/debug/plugins/sentinel/core/status.ts` — `sentinelVitalsResource`; status value gains `duress`
- `plugins/debug/plugins/sentinel/server/internal/status-resource.ts` — vitals resource, latch read, routed watcher, latch-dir watch
- `plugins/debug/plugins/sentinel/web/internal/machine-watcher-health.ts` — duress branch, new value shape
- `plugins/debug/plugins/sentinel/web/internal/vitals-view.ts`, `web/components/machine-watcher-{glance,detail}.tsx` (new)
- `plugins/debug/plugins/sentinel/web/index.ts` — `glance` + `component`
- `plugins/debug/plugins/sentinel/CLAUDE.md` and `status-file/data-dirs/index.ts` description — the directory now also holds `vitals.json`

## Verification

- `./equin test plugins/debug/plugins/sentinel`:
  - `vitals-file.test.ts` — write/read round trip; missing → `none`; garbage → `unreadable`.
  - `vitals-view.test.ts` — tone at ⅔ and at the limit, null value, stale by age and by pid mismatch, banner wording.
  - `machine-watcher-health.test.ts` — the duress branch.
  - Extend the worker test that injects `__sample` frames (`latch-lapse.test.ts` pattern): after a tick `vitals.json` exists with the injected readings and the configured limits; a tripping sample sets `tripped` and `elevated`.
- `./equin check sentinel:worker-closure-lean sentinel:status-file-lean type-check`.
- `./equin build`, then on the deploy: open the health popover and expand
  Machine watcher (`screenshot.ts --click "All systems normal"`, then click
  the row) and compare against proto-1789664064-nr56's `calm` state. Confirm
  `~/.singularity/locks/sentinel/vitals.json` updates every 5 s, and that with
  the popover closed no `sentinel.vitals` messages arrive on the socket.
- Duress path: lower `Onset: load ratio` in Settings → Config to below current
  load; within ~15 s the row turns red with "Under duress since…" and the
  banner names load; restore the setting and it clears.

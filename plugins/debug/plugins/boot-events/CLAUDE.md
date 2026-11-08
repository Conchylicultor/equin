# boot-events

Two durable lines per backend boot, so a **deploy-restart burst is visible as
interval bars** on cross-worktree timelines — including a backend that
**wedges mid-boot**, previously invisible exactly during those bursts (see
`research/2026-07-10-global-congestion-observability.md`, Phase A, and
`research/2026-07-11-global-observability-freeze-blind-spots.md`, Stage 7).

Both lines go to the persisted `boot` log channel →
`~/.equin/worktrees/<wt>/logs/boot.jsonl`:

- **`phase: "start"`** — written by the serving entry point itself
  (`writeBootStartEvent`, from server-core's `bin/index.ts` beside its
  `boot-start` checkpoint), before any plugin import. It used to be the
  register phase's, which runs only after every import — 60–100 s under load
  on 2026-11-04, so a boot the gateway killed while importing left no line and
  its predecessor read as the latest attempt. No host service is up that
  early, so it appends through the channel's own memoised file sink
  (`channelFileSink`, the one the desktop's log persistence writes the later
  lines through). **Serve mode only**, by construction — only the serving
  entry point calls it; an `exec` child never reaches `onReady`, so its
  `start` would never pair.
- **`phase: "ready"`** — written from `onReady` (post-`onReadyBlocking`
  readiness — a migrated DB and ready registry), carrying `readyAt`.
- **`phase: "exited"`** — written from the process's `exit` event (armed by
  the same call) when it fires before `ready`, carrying `exitedAt`:
  a boot that threw (a failed migration, a boot assert) exited, it did not
  wedge. Without it a crashed boot read exactly like a wedge, and the boot
  watchdog filed one whose "un-ready" time ran until the next build's boot. A
  signal kill runs no listener, so a backend killed mid-boot writes none and
  stays "never ready".
- **`phase: "dead"`** — the one line another process writes: the boot
  watchdog (`writeBootDeadEvent`, main), once the gateway shows a never-ready
  boot's process is gone and it has reported it. Carries `deadBy` (the
  superseding start, else the watchdog's observation — an upper bound on the
  kill). It **settles** a killed boot: without it a SIGKILLed boot stayed open
  forever — an eternal timeline bar, an unsettled mark read every minute, and
  a report re-filed on every main restart. A later `ready` line still wins.

**A boot crash is a report.** Until `ready`, the plugin's `machine/` half
(filing needs the computer) holds `uncaughtException` / `unhandledRejection`
listeners, armed in its register phase (`machine/internal/boot-crash.ts`): the error is printed (the gateway quotes the
backend's last stderr lines back to the build), filed as a `crash` report
through the report outbox (`reports/outbox` — with the checkout's merge-base
and the stack's repo files, so main drops it once it has changed that code),
and the process exits 1. Server-core's own crash listeners (installed by the
entry point before the graph loads) dispatch to `processCrashSink`, whose
handler — the reports engine's — attaches only in the engine's
`onReadyBlocking`, so before this a boot that threw earlier reached Reports
through nothing — or, when no build was watching (a cold start on a page load,
the gateway respawning main), through the boot watchdog misreading it as a
wedge. The listeners come off at `ready`, and step aside as soon as a
`processCrashSink` handler is attached (`isProcessCrashHandled()`), which then
owns the process's crashes; until then the framework's listener stands down
for these. They are the one plugin-installed crash listener
(`server-core/no-process-crash-listener`, sanctioned in `exempt/`).

```json
{ "sampledAt": <ms>, "worktree": "<wt>", "processStartedAt": <ms>, "phase": "start" }
{ "sampledAt": <ms>, "worktree": "<wt>", "processStartedAt": <ms>, "readyAt": <ms>, "phase": "ready" }
{ "sampledAt": <ms>, "worktree": "<wt>", "processStartedAt": <ms>, "exitedAt": <ms>, "phase": "exited" }
{ "sampledAt": <ms>, "worktree": "<wt>", "processStartedAt": <ms>, "deadBy": <ms>, "phase": "dead" }
```

A boot is the wall-clock interval `[processStartedAt, readyAt]`
(`processStartedAt` = `Math.round(performance.timeOrigin)`, the pairing key).
Wall-clock ms epoch is the only clock on the line — profiler clocks are
incomparable across backends. Pre-cutover lines lack `phase` and parse as
ready lines.

**A log-channel line, not a table**: no migration, survives DB re-forks, and
the main backend can read it off disk while the owning backend is wedged.

**Bounding**: log-channels' `appendEntry` already rotates every channel file at
a 128 MB cap (3 rotated files kept) — at two ~140-byte lines per boot that is
effectively unbounded history, so there is deliberately **no custom rotation**
here (the plan's "~256 KB tiny cap" is subsumed by the substrate's rotation).

**The boot journal, read back**: `readBootJournals(worktree)` summarises
server-core's `boot-journal` channel per boot (`boot-journal.ts`, pure +
tested): when its imports finished (`after-import`), its longest import waves
and blocking hooks, the step still open when the journal ends (`diedIn` — a
load wave or blocking hook opens a journal line as it starts, so a SIGKILLed
boot names where it was), and how long it ran darwinbg (`darwinbg-at-start` →
`left-darwinbg`). The boot watchdog puts it in its report. Read only for a
worktree with a never-ready boot: the journal is ~100 lines a boot.

**Reading**: `readBootEvents(worktree, windowMs)` pairs the lines by
`processStartedAt` (`pair-boot-lines.ts`, pure + tested) into `BootEvent`s
whose interval overlaps the window. A start without a ready line is a boot
that never became ready: `readyAt: null` — a crash when an exited line pairs
with it (`exitedAt`, its bar ends there), known dead when a dead line does
(`deadBy`, its bar ends there), otherwise bounded by the next attempt's start
(`supersededAtMs`) when one follows — a crash-loop must not render as a stack
of eternal open bars — and open-ended (the timeline renders it to the window
edge, pulsing) when it is the latest attempt. Mirrors health-monitor's
`read-health-files.ts` — a bounded `readChannelEntries` tail, inner-JSON parse,
`safeParse`-drop of malformed lines.

## Unsettled-boot marks

`machine/internal/unsettled-marks.ts`: one empty file per worktree under
`~/.equin/cache/boot-unsettled/` (`data-dirs`), written by the serving entry
point beside the boot's `start` line, before any plugin import
(`markBootUnsettled` from server-core's `bin/index.ts`) — the index of worktrees whose boot channel
can hold an open boot. The boot watchdog also marks any open boot it reads (a
backend predating the marks, or a mark that raced its read), and is the only one
to clear a mark (`clearBootUnsettled`, after reading the channel as settled; a
mark newer than that read is kept). A killed boot settles when the watchdog
writes it `dead`. So it reads the marked worktrees plus the
gateway's live ones, not every worktree's `boot.jsonl`. `.indexed` stamps the
marks complete; without it the watchdog sweeps every worktree once to mark the
boots from before the marks.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Durable per-boot event lines: a `start` line as the serving process starts, before its plugin imports (so a backend wedged during migrations/boot is visible as an open-ended bar) and a `ready` line from the onReady hook, paired by processStartedAt into the wall-clock interval readBootEvents(worktree, windowMs) returns — so deploy-restart bursts render on cross-worktree timelines, with no DB table (survives re-forks, readable while a backend is wedged).
- Server:
  - Uses:
    - `primitives/log-channels.defineLogSink`
    - `primitives/log-channels/log-files.channelFileSink`
    - `primitives/log-channels/log-files.logEnvelope`
    - `primitives/log-channels/log-files.logsDirFor`
    - `primitives/log-channels/log-files.readChannelJson`
  - DB schema: `plugins/debug/plugins/boot-events/server/internal/schema.ts`
  - Exports (types):
    - `BootEvent`
    - `BootJournalSummary`
    - `BootLine`
  - Exports (values):
    - `BootLineSchema`
    - `readBootEvents`
    - `readBootJournals`
    - `writeBootDeadEvent`
    - `writeBootStartEvent`
- Cross-plugin:
  - Imported by:
    - `debug/boot-watchdog`
    - `debug/timeline`
- Exemptions:
  - Exempts itself from:
    - `server-core/no-process-crash-listener` — `machine/internal/boot-crash.ts` (sanctioned)
    - `blocking-fs/no-sync-fs` — `machine/internal/own-boot-mark.ts` (sanctioned)
    - `blocking-fs/no-sync-fs` — `server/internal/write-boot-event.ts` (debt)
- Machine:
  - Exports (values):
    - `clearBootUnsettled`
    - `markBootUnsettled`
    - `markOwnBootUnsettled`
    - `readBootUnsettled`
    - `stampBootUnsettledIndexed`

<!-- AUTOGENERATED:END -->

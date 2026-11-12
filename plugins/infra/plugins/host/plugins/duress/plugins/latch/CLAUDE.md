# latch

The host-global duress latch — the cross-process "the box is in trouble"
signal. A single file, `~/.equin/locks/duress/duress.latch` (JSON `{ setAt, reason }`),
whose **mtime freshness** (< `FRESHNESS_LEASE_MS`, 60 s) carries liveness: the
sentinel refreshes it every tick while tripped, so a crashed sentinel lapses
the lease and the fleet self-recovers. See the parent `duress` plugin's
CLAUDE.md for the full lifecycle and lease contract.

## No call touches the disk synchronously

A sync fs call on a backend's JS thread freezes it for as long as the disk
answers (3–13 s stalls recorded on main), and the gate is read precisely when
the box is in trouble. So:

- **The gate** — `isUnderDuress()` / `duressEpisode()`, synchronous and free,
  for the hot paths (log-channel ingress, the shed buffer's admit, the
  latency-ledger recorder) — answers from an in-process **held copy** of the
  latch (payload + mtime). It never stats: the lease is judged from the held
  mtime against the clock, so a lapse (a sentinel that died mid-episode) needs
  no event to be noticed.
- **The held copy** is kept current by one non-recursive, non-persistent
  `fs.watch` on the latch directory filtered to the latch filename: every change
  re-reads the file (async stat + read, coalesced — one read in flight, one
  pending). This process's own writes set it as they land, and a read that
  started before an own write is discarded (`writeGen`). A missed event is
  bounded without a poll: a missed set is heard at the sentinel's next refresh
  (an mtime bump every tick while tripped), a missed clear lasts at most the
  lease, which then lapses on the clock.
- **Failures of the latch's own machinery never crash the process** — the
  latch directory is shared by every backend, so a bad file or watch event
  would take them all down at once. A watch that fails to open (a failed mkdir,
  EMFILE under descriptor pressure) or breaks (its `error` event) is dropped and
  reported (stderr, and `duressLatchFaultSink` — which the latch's `machine/` half attaches to `reportServerError`, scope `duress-latch`, in a desktop backend; the latch itself cannot name server-core, see `sentinel:worker-closure-lean`); a later gate read
  re-arms it, at most once per `REARM_AFTER_MS` (5 s) so a persistent failure
  does not turn every hot-path read into a retry. A re-read that fails (an
  unreadable or corrupt latch) is reported and the held copy kept. Meanwhile
  the gate answers from its held copy, its lease still judged on the clock.
- **Not known yet** (before the first read lands) the gate answers `false` —
  calm-host behaviour for the length of one async stat, the state every process
  boots into anyway. A backend never shows that window to a plugin: the
  plugin's `onReadyBlocking` is `watchDuress()`, which opens the watch and awaits
  the first read before any dependent's hook runs. Any other process arms the
  watch on its first gate read (a `runTracked` span).
- **Fresh reads** — `readDuress()` (payload + `fresh`) and `readFreshDuress()`
  (payload only while fresh) are async and read the file now. A reader woken BY
  a change to the latch (the sentinel's `sentinel.status` resource, the CLI's
  admission valve, the build's post-grant re-check) uses them: its own watch
  event may land before the held copy's.
- **Writers** — `setDuress` (temp file + rename, so a woken reader never parses
  half a payload; returns the latch it wrote — `setAt` is the episode id),
  `refreshDuress`, `clearDuress` — are async. They run on the cluster sentinel's
  worker thread, which serializes each tick's detector feed and latch write.

Why a raw `fs.watch` rather than `defineFileWatcher` (a sanctioned
`watcher-safety/no-raw-fs-watch` exemption): this plugin is a leaf imported by
processes with no plugin runtime to mount a declaration in (the CLI, the
sentinel's worker) and by tests that never boot one, and `@parcel/watcher`'s
native addon would join the CLI's startup closure through the barrel.

## A leaf on purpose

Module-eval depends only on `node:fs`, `infra/paths` and pure packages
(`timed-fs`, `coalesce`, `runtime-profiler/core`) — no config_v2, no DB, no
runtime-namespace identity — so processes outside a backend (the CLI's build
admission valve,
`plugins/framework/plugins/cli/plugins/op-runtime/cli/admission-valve.ts`) can
import it safely. The `shed` sibling drags config_v2 (whose module-eval asserts
a worktree identity), which is exactly what the CLI cannot evaluate. Do not add
config/DB/backend dependencies here — that would re-poison every
env-independent importer.

`_setLatchDirForTests` / `_setClockForTests` / `_nextLatchReadForTests` /
`_breakLatchWatchForTests` are test seams (temp-dir latch, injectable clock —
setAt, the written mtime, the lease math and the re-arm delay all follow it — a
wait for the watch's next read of a write made behind the API's back, and a
watch `error` event), used by this plugin's co-located test, the shed engine's
and log-channels' emit test.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The host-global duress latch file (mtime-leased, set/refresh/clear by the cluster sentinel, read via the free synchronous isUnderDuress() from an in-process copy a watch on the latch dir keeps current). A leaf on purpose: module-eval depends only on node:fs + infra/paths — no config, no DB, no worktree identity — so env-independent processes (the CLI's build admission valve, the sentinel's worker) can import it safely.
- Cross-plugin:
  - Imported by:
    - `debug/latency-ledger`
    - `debug/sentinel`
    - `framework/cli/build`
    - `framework/cli/op-runtime`
    - `infra/host/duress/shed`
    - `infra/host/idle/duress`
    - `primitives/log-channels`
- Exemptions:
  - Exempts itself from:
    - `boundaries/no-platform-api` — `server/internal/latch.ts` (debt)
    - `watcher-safety/no-raw-fs-watch` — `server/internal/latch.ts` (sanctioned)
- Server:
  - Exports (types):
    - `DuressLatch`
    - `DuressLatchFault`
    - `DuressReading`
  - Exports (values):
    - `clearDuress`
    - `duressEpisode`
    - `duressLatchDir`
    - `duressLatchFaultSink`
    - `FRESHNESS_LEASE_MS`
    - `isUnderDuress`
    - `LATCH_FILENAME`
    - `readDuress`
    - `readFreshDuress`
    - `refreshDuress`
    - `setDuress`
- Test helpers:
  - Server: `@plugins/infra/plugins/host/plugins/duress/plugins/latch/server/testing`
    - `_breakLatchWatchForTests` — Break the open watch as the platform would (its "error" event).
    - `_nextLatchReadForTests` — Resolves after the watch next re-reads the file — a write from "another process" landed.
    - `_setClockForTests` — Override the clock (lease math, setAt).
    - `_setLatchDirForTests` — Point the latch at a temp dir (null restores the declared dir); drops the watch.

<!-- AUTOGENERATED:END -->

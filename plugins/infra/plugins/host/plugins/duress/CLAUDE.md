# duress

Host-global duress latch — the cross-process "the box is in trouble" signal for
the congestion-observability stack
(`research/2026-07-10-global-congestion-observability.md`, Phase B/C).

The latch is a single file, `~/.singularity/locks/duress/duress.latch` (JSON
`{ setAt, reason }`), derived from `SINGULARITY_DIR` in `infra/paths`. A file is
the channel on purpose: it needs no DB, no sockets, and no cooperating event
loop, so it stays writable and readable precisely when everything else on the
box is wedged — which is the only time it matters.

**Writer** — the Phase-B cluster sentinel on main, exclusively. It owns the
whole lifecycle: `setDuress(reason)` on trip, `refreshDuress()` every tick while
tripped, `clearDuress()` on clear. `refreshDuress` **throws** if the latch is
absent — refresh without a prior set is a sentinel lifecycle bug, and absorbing
it would hide a sentinel that lost track of its own episode. `clearDuress` is
idempotent (clearing twice is a legitimate race between trip-clear and
shutdown).

**Readers** — every backend's observability choke points (Phase C: trace
capture, slow-op recording, report filing) gate durable writes on
`isUnderDuress()`. The read contract is *cheap and synchronous*, because it runs
on hot paths inside possibly-struggling event loops: one `statSync` at most once
per `MEMO_TTL_MS` (2 s, in-process memo), no file read. ENOENT is the normal
healthy state (→ `false`); any other fs error throws. `readDuress()` is the
separate cold diagnostic path that actually reads the payload.

## The freshness lease

Duress holds only while the latch's **mtime is fresh** (`< FRESHNESS_LEASE_MS`,
60 s) — existence alone is not enough. This is the crash-safety invariant: the
sentinel refreshes the mtime every tick while tripped, so if the sentinel (or
all of main) crashes mid-episode, the lease lapses within 60 s and the fleet
self-recovers instead of being wedged into permanent shedding by a stale file.
A latch that nobody is alive to refresh is, by definition, no longer a valid
duress signal. Mutations (`set`/`refresh`/`clear`) invalidate the local memo, so
the writer process never has a memo-TTL blind spot on its own transitions;
other processes converge within `MEMO_TTL_MS`.

Both constants are exported (`FRESHNESS_LEASE_MS`, `MEMO_TTL_MS`) — the sentinel
must pick a refresh tick well under the lease, and tests assert against them.

`duressEpisode()` is the third hot-path read: the current episode's identity
(the latch's `setAt`), under the same memo contract as `isUnderDuress` (one
file read at most once per `MEMO_TTL_MS`, mutations invalidate). The shed
engine consults it on every under-duress admit; a `setAt` change is how it
detects a NEW episode, and ≤ `MEMO_TTL_MS` staleness only delays a first-N
counter reset by that much.

## The shed engine (Phase C)

`createShedBuffer<T>({ kind, cascadeKeyOf, replay, onFlushSummary? })`
(`plugins/shed`, `server/internal/shed-buffer.ts`) is how the observability choke points shed
durable writes during an episode without losing the accounting. The three C2
consumers are wired: trace capture (`debug/trace/engine`, buffer `traces`,
cascade `kind:label`, stub-only with a no-op replay), the slow-op funnel
(`debug/slow-ops`, buffer `slow-ops`, cascade `operationKind:operation`,
replay re-drives `recordSlowOp`), and the report funnel (`reports`, buffer
`reports`, cascade = fingerprint, replay re-drives `recordReport`). Each wires
`onFlushSummary` to a `duress-shed` report (kind registered by
`debug/duress-shed`, which marks itself `duressExempt` so the accounting can
never itself be shed). **Consumers construct the buffer and supply `replay`**
(re-driving their own durable path) — duress never imports
reports/slow-ops/trace, so the `reports → duress` edge stays acyclic and
duress remains a leaf primitive.

`admit(item)` returns `{persist: boolean}`. Outside an episode (or with the
config `enabled` off) it is a pass-through: always `{persist: true}`, plus a
lazy check that arms an owed flush. During an episode (keyed by the latch's
`setAt` via `duressEpisode()`):

- The **first N per cascade key** (`persistFirstN`, per episode — a new
  `setAt` re-grants it) persist through the normal durable path: the onset
  evidence always lands. Past N, the item is buffered in memory and
  `{persist: false}`.
- **Bounds**: `bufferMaxEntries` per buffer plus a soft `bufferMaxBytes` cap
  (JSON.stringify-length estimate, accumulated on insert). Overflow drops the
  **newest incoming** item — first-N already captured the onset; the freshest
  storm tail has the least marginal value — and increments the per-cascade
  `dropped` count, which survives into the summary even though the item
  doesn't. Crash-loss is user-accepted: first-N is durable, the buffered tail
  is memory-only.
- **Flush** is lazy (no poll): the first admit that observes the latch cleared
  while anything is owed arms a ONE-SHOT `setTimeout(flushDelayMs)`. The
  callback re-checks `isUnderDuress()` at fire time — a re-trip while pending
  means it declines, and the next clear-observing admit re-arms; the one-shot
  is never cancelled. The flush replays in bounded chunks (100) under
  `runInBackgroundLane(() => runWithoutProfiling(...))` (recovery is
  monitoring work: off the interactive lane, invisible to the profiler), then
  calls `onFlushSummary` once with `{kind, episodeSetAt, byCascade: {shed,
  dropped}, replayed, replayErrors}`. A throwing chunk is counted, logged to
  the `duress` log channel, and skipped — evidence recovery is best-effort,
  never a crash loop.

All bookkeeping (episode reset, first-N, caps, drop accounting, flush
eligibility) lives in the pure `createShedCore` (no fs/config/clock/timer),
which the wrapper binds to the latch, the live config, and the timer.

## Config

`duressConfig` (`core/config.ts`, registered server-side and web-side for
Settings → Config): `enabled`, `persistFirstN` (3), `bufferMaxEntries` (2000),
`bufferMaxBytes` (4 MB), `flushDelayMs` (30 s). Read per admit via `getConfig`
(in-memory, cheap), so tuning is live.

## Module layout

- `plugins/latch/` — the whole latch (state, fs, memos) + its co-located bun
  test, as a **leaf sub-plugin** whose module-eval depends only on `node:fs` +
  `infra/paths` — no config_v2, no worktree identity — so env-independent
  processes (the CLI's build admission valve) can import
  `@plugins/infra/plugins/host/plugins/duress/plugins/latch/server` safely, which the
  shed engine (dragging config_v2) is not. The parent
  does NOT re-export the latch (cross-plugin re-exports are banned); every
  consumer imports the latch barrel directly. Its test seams
  (`_setLatchDirForTests` temp-dir latch, `_setClockForTests` injectable
  clock) are on the latch barrel, used by its own test and the shed engine's.
- `plugins/shed/` — the shed engine (pure core + impure wrapper) + its
  co-located bun test, which drives real duress state through the latch seams
  plus `_setShedConfigForTests` / `_setFlushTimerForTests`. Consumers import
  `@plugins/infra/plugins/host/plugins/duress/plugins/shed/server`. A
  sub-plugin so this parent's `server/` barrel holds only the config
  registration and is `portable: true`: the engine reads the latch (the host's
  filesystem), while the config must be served by every host whose page
  registers it — a browser host's worker included
  (`config-v2:host-registrations-paired`).
- `core/` exists for the config descriptor (shared by the server registration,
  the web `ConfigV2.WebRegister` and the shed engine's `getConfig`);
  `server/index.ts` and `web/index.ts` are those two registrations only.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Duress web presence: registers the shed-engine config (enabled, persist-first-N, buffer caps, flush delay) for Settings → Config. Host-global duress: registers the shed engine's config (enabled, persist-first-N, buffer caps, flush delay). The latch file (a mtime-leased latch the cluster sentinel sets while the box is in trouble, read via the cheap synchronous isUnderDuress()) is the latch sub-plugin, the shed engine (per-episode first-N persistence, a bounded buffer, flush-on-clear replay) the shed sub-plugin.
- Web:
  - Contributes: `ConfigV2.WebRegister` "duress"
  - Uses: `config_v2.ConfigV2`
- Server:
  - Contributes: `ConfigV2.Register` "duress"
  - Uses:
    - `config_v2.ConfigV2`
    - `config_v2.getConfig`
  - Exports (values): `readDuressConfig`
- Core:
  - Uses:
    - `config_v2.defineConfig`
    - `fields/bool/config.boolField`
    - `fields/int/config.intField`
  - Exports (values): `duressConfig`
- Cross-plugin:
  - Imported by: `infra/host/duress/shed`
- Sub-plugins:
  - **`latch`** — The host-global duress latch file (mtime-leased, set/refresh/clear by the cluster sentinel, read via the cheap synchronous isUnderDuress()). A leaf on purpose: module-eval depends only on node:fs +…
  - **`shed`** — The duress shed engine: createShedBuffer routes an observability choke point's durable writes through per-episode first-N persistence, a bounded in-memory buffer and a flush-on-clear replay, gated…

<!-- AUTOGENERATED:END -->

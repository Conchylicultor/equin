# timeline

The **unified cross-worktree slow-event timeline** (plan:
`research/2026-07-10-global-congestion-observability.md`, Phase A). Today an
incident is reconstructed by hand across five stores; this plugin builds the
merge: one scan fans out over every live worktree DB fork **and** the
per-worktree disk logs, normalizes everything to a single wall-clock wire
model, and serves it as a live value filled in as the fan-out resolves. The web tab (Debug → Slow Events →
Timeline) renders it as per-worktree lanes.

## Wire model (`core/`)

`TimelineEvent { id, source, worktree, startMs, endMs, label, severity,
traceId?, detail }` — **wall-clock epoch ms is the ONLY clock on the wire**.
Profiler-clock values are incomparable across backends (trace-engine clock
discipline), so every source converts at extraction; durations transfer
as-is. The seven sources are a **closed list** (closed-list rule — fan-out
mechanics are timeline-owned; revisit as a slot only if a non-debug plugin
ever needs to feed it):

| Source | Access | Interval |
|---|---|---|
| `trace` | DB fan-out | `[wallTime − (atMs − windowStartMs), wallTime]`; critical trigger → error |
| `slow-op` | DB fan-out | each `recentSamples` entry → `[atTime − durationMs, atTime]`; ≥5× threshold → error |
| `report` | DB fan-out | point at `lastSeenAt`; crash-like kind → error, noise → info |
| `build` | DB fan-out | `[startedAt, finishedAt]`; in-flight → open-ended to `toMs` + `detail.inFlight`; exit ≠ 0 → error |
| `boot` | disk (boot-events) | `[processStartedAt, readyAt]` per boot; never-ready → bounded by the next attempt (warning) or open-ended to `toMs` + `detail.inFlight` |
| `duress` | disk (sentinel duress-episodes, main only) | `[episodeSetAt, clearAtMs]` per episode; no clear line → open-ended to `toMs` (recent) or bounded at trip + 30 min / the next episode with `detail.endUnknown` (lapsed). Host-global: renders as a cross-lane warning band + badge row, not a lane |
| `health` | disk (health JSONL) | NOT events — downsampled series frames (≤500 pts/lane, bucket-max on p99 / the host pressure score), host vitals on the `"host"` lane |

**Host-lane pressure score** (`shared/pressure.ts`): one shared
`hostPressureScore` — max of the loadAvg1/cpuCount ramp and the macOS
memory-compressor decompressions/sec ramp (mild ≥ 20k/s, strong ≥ 100k/s,
error ≥ 250k/s; calibratable, from the 2026-07-11 freeze forensics) — is both
the server's downsample `valueOf` AND the web heat-strip severity, so the
points that survive downsampling are exactly the points the strip colors
worst. A compressor-thrash freeze (swap ≈ 0, decompressions 240k–442k/s) now
renders error heat instead of "memory pressure ≈ 0".

**Dark segments** (`web/internal/heat.ts`): a point's heat half-span is capped
at 3× the series' median inter-sample gap, and any gap beyond 6× median
renders its uncovered stretch as a hatched **dark** segment — labeled `sleep`
when the gap-ending point carries the sampler's `wallJumpMs` stamp, else
"sampler dark" (wedged, dead, or no history — during a freeze, the honest
answer). Sleep-wake points are force-kept through downsampling (they carry no
severity but classify their gap).

**Duress bands**: a duress episode is the "this window is thinned" marker —
shed slow-ops/reports inside it are expected to be sparse. Its events ride the
scan as one host-lane cell but render as full-height warning-tinted bands
behind all lanes plus a clickable reason-labeled badge row (never a worktree
lane), and they are excluded from the incident sweep (host-global spans would
chain everything they overlap into one mega-incident). An episode with no
clear line either renders open-ended (its provable bound — trip +
`MAX_OPEN_EPISODE_MS`, mirroring the sentinel's max-episode-hold default, or
the next episode's trip — lies past the window edge) or bounded with
`endUnknown` (a lease lapse writes no line; the accepted Stage 3 gap, never
still-open forever).

## The scan value — `debug.timeline.scan` (`shared/scan.ts`)

A typed-query value, `{ lookbackMs, at }`: the preset ending at `at`, the
instant the tab asked (mount, Refresh, a preset change — each a new window
ending now, so each a new question). Served external `"notified"`
(`server/internal/scan-served.ts`): the question's first subscriber starts
ONE fan-out (`produceTimeline`), its frames are folded into the answer
`{ fromMs, toMs, total, done, complete, cells, health }` and pushed — as
patches, every list append-only — about 40 times over the scan, then once on
completion; a complete scan never moves. The last unsubscribe drops it (a
fan-out still running finishes into nothing). Refused `invalid-window` (a
non-positive lookback, or one reaching before the epoch). A whole-scan
failure (the fork list unreadable) fails the read, and the failed scan is held
as failed — so the error's Retry asks a new question (a new `at`), as Refresh
does.

- **Kept cells** are the ones that carry something: an ok cell with ≥ 1 event
  (an empty one adds no lane — it is counted in `done`, not kept) or a failed
  one (one broken fork = one error row, never a blank view).
- **Bound:** cells ≤ live forks × 4 DB sources + the worktrees with a boot in
  the window + 1 (duress); each cell keeps its newest
  `TIMELINE_CELL_EVENT_CAP` (500) events and counts the rest in `omitted`
  (the tab says "N older not shown"); health ≤ one ≤ ~500-point frame per lane
  with samples in the window.

## Fan-out mechanics (`server/internal/`)

Mirrors the slow-ops **cluster** tab: `listLiveForkDatabases()` →
`openShortLivedClient(db)` under `createSemaphore(6)`, one chunk per
(DB × source) with per-cell try/catch. Two hardenings on top of the
precedent:

- **`SET statement_timeout = 10000` per session** (one held `pool.connect()`
  client per DB visit, so the setting can't be lost to pool recycling): this
  view opens *during* incidents; a saturated fork must error-row, not hang.
- The whole producer runs under
  `runInBackgroundLane(() => runWithoutProfiling(...))` — observability never
  feeds the profiler or rides the interactive lane.

**Fork-inherited rows are scoped out.** A fork DB inherits main's
traces/slow_ops/reports at fork time; without scoping, main's burst would
render once per fork. Fork DBs filter `worktree = <dbName>` (fork DB names
ARE worktree slugs — the identity mapping the cluster tab uses); the main DB
stays unfiltered (it is the authority, and this sidesteps legacy rows with a
fallback worktree value). `build_runs` carries `namespace` instead, and
*every* DB — main included — filters `namespace = <dbName>`, per that
table's own inherited-row convention.

Disk lanes (boot, health) enumerate worktree **log dirs** (health-monitor's
scan), not DBs — readable from main even while a backend is wedged.

**No new tables, no retention, no polling.** Each source
keeps its own retention (traces 7d, health JSONL ~days before rotation); the
UI hints lookback limits.

## Tests

Pure logic (interval mapping, overlap, severity, downsampling, in-flight
builds) is co-located `bun:test`:

```bash
bun test plugins/debug/plugins/timeline
```

## Agent access

The **`get_timeline` MCP tool** is the primary agent surface — the web tab's
live value is not practically consumable by an agent, so this tool drives the SAME
`produceTimeline` producer **in-process** (`server/internal/collect.ts`) and
renders the frames as a compact, local-time text report
(`server/internal/render.ts`). Use it — not raw jsonl logs — to reconstruct a
slowness/freeze/memory-pressure incident across the cluster.

- **Backend-independent, so no `worktree` arg** (a named deviation from the
  `get_queue_health` / `get_runtime_profile` gateway-fetch precedent, whose
  point is reaching *another* backend's live in-memory state; the timeline's
  answer is fork-DB fan-out + shared host filesystem reads, with no other
  backend to reach).
- Window: `lookbackMinutes` (default 30, max 1440) ending now or at `endIso`;
  filter with `minSeverity` / `sources` / `maxEvents`. **Epoch ms is never
  exposed** — all times are local with the tz in the header.
- Report shape: DURESS episodes first (never capped — signal is thinned inside
  them), then host-pressure + backend-health peaks (summarized, never dumped),
  then EVENTS (severity-first retention, re-sorted by wall clock) with
  **explicit per-source drop accounting** and a **CHUNK ERRORS** block so
  missing data never reads as calm.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Timeline tab for the Slow Events pane: the unified cross-worktree wall-clock Gantt — per-worktree lanes of traces / slow-ops / reports / builds / boots with health heat strips and cross-worktree incident bands, read live from the debug.timeline.scan value as the fan-out resolves. Cross-worktree unified timeline: fans out over every live worktree DB fork (traces, slow-op samples, reports, builds) plus the per-worktree disk logs (boot events, health series), normalizes everything to wall-clock TimelineEvents, and serves it as the debug.timeline.scan live value — one scan per window, pushed as each cell resolves.
- Web:
  - Contributes: `SlowEvents.View` "Timeline" → `TimelineView`
  - Uses: 37 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `debug/profiling` ×7
    - `debug/trace/pane` ×5
    - `primitives/css/coords` ×2
    - `primitives/css/spacing` ×2
    - `primitives/css/ui-kit` ×2
    - `network/live.useLive`
    - `primitives/css/badge.Badge`
    - `primitives/css/clip.Clip`
    - `primitives/css/cluster.Cluster`
    - `primitives/css/column.Column`
    - `primitives/css/fill.Fill`
    - `primitives/css/grow.growClass`
    - `primitives/css/line.Line`
    - `primitives/css/overlay.Overlay`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/status-dot.StatusDot`
    - `primitives/css/text.Text`
    - `primitives/css/toggle-chip.SegmentedControl`
    - `primitives/icon-button.IconButton`
    - `primitives/live-state.ResourceErrorInline`
    - `primitives/pane.useOpenPane`
    - `primitives/syntax-highlight.HighlightedCode`
- Server:
  - Contributes: `resource.declare` "debug.timeline.scan"
  - Uses:
    - `database/admin.openShortLivedClient`
    - `debug/boot-events.readBootEvents`
    - `debug/health-monitor.HealthSample`
    - `debug/health-monitor.HealthSampleSchema`
    - `debug/health-monitor.HostSample`
    - `debug/health-monitor.HostSampleSchema`
    - `debug/sentinel.readDuressEpisodes`
    - `debug/slow-ops/cluster.listLiveForkDatabases`
    - `infra/mcp.Mcp`
    - `infra/paths.listWorktreeDirs`
    - `network/live.serveValue`
    - `primitives/log-channels/log-files.readChannelJson`
  - Register: `mcpTool('get_timeline')`
  - Resources: `debug.timeline.scan` (push, notified, whole: ≤ live forks × 4 DB sources + the worktrees with a boot in the window + 1 (duress) — the live forks only, not every database on the host, whole: one frame per worktree lane with samples in the window, plus the host lane, capped: TIMELINE_CELL_EVENT_CAP, whole: one lane's series downsampled to ≤ 500 buckets, plus the few sleep-wake points kept beside them, whole: one event's few source-specific fields, written by its extractor)
- Core:
  - Uses: `packages/list-bound.wholeRecord`
  - Exports (types):
    - `TimelineEvent`
    - `TimelineSeverity`
    - `TimelineSource`
  - Exports (values):
    - `TIMELINE_SOURCES`
    - `TimelineEventSchema`
    - `TimelineSeveritySchema`
    - `TimelineSourceSchema`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/categorical --categorical-1`
    - `ui/tokens/categorical --categorical-2`
    - `ui/tokens/categorical --categorical-3`
    - `ui/tokens/categorical --categorical-4`
    - `ui/tokens/categorical --categorical-5`
    - `ui/tokens/categorical --categorical-6`
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/color-palette --warning`
    - `ui/tokens/density --space-2xs`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/font-family --font-mono`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-weight-medium`
- Exemptions:
  - Exempts itself from:
    - `no-db-backed-notify` — `server/internal/scan-served.ts` (sanctioned)
    - `boundaries/no-platform-api` — `server/internal/mcp-tool.ts`, `server/internal/sources/health.ts` (debt)

<!-- AUTOGENERATED:END -->

# Live-state observability + loud watchdog

## Context

A user reported a conversation's status badge stuck on "Waiting" while the agent
was "working", fixed only by opening a new tab / refreshing. Investigation proved
the **server and DB are correct**: the poller writes `conversations.status` every
1s, and the DB row + tmux/session state agreed at inspection time. The failure is
purely **client-side**: a server-pushed resource update never reaches an
already-open tab, and a full page load (which rebuilds the module-singleton
WebSocket and re-fetches) is the only thing that recovers it.

The update path is a long multi-hop chain that **drops silently at nearly every
hop** with almost no logging and no safety net:

```
server notify → /ws/notifications → LEADER tab WS.onmessage
   → BroadcastChannel → FOLLOWER tab → setQueryData → React render
```

Why this class is uniquely hard to debug:

- **No safety net.** `use-resource.ts:23–31` sets `staleTime: Infinity`,
  `refetchOnReconnect: false`, `refetchOnWindowFocus: false`. The WS is the *sole*
  source of truth; a missed frame is never re-fetched.
- **Module-singleton never reset** (`use-resource.ts:52`). If its `SharedWebSocket`
  reaches `closed=true`, or cross-tab leader election wedges with *no leader*,
  `send()` early-returns: the sub op never reaches the server, no `sub-ack` ever
  comes back, and the tab is stale **forever until refresh**. This matches the
  "only refresh fixes it" symptom far better than a transient reconnect gap (which
  self-heals via `sub-ack` within seconds, without a refresh).
- **Near-zero logging.** The entire path has one `console.error` (a `sub-error`
  frame). Every drop point — version-guard, missing-sub, schema-parse throw,
  leader-election transitions, `replaySubs` — is invisible.

**Goal:** make this whole bug *class* catchable and loud, so the next occurrence
leaves a durable trail that localizes the dead hop, and the user is told their
data is stale instead of staring at a frozen badge.

**Non-goal (deferred):** the targeted root-cause fix (why the singleton/election
wedges). We cannot confirm the exact hop until the instrumentation catches it in
the wild; this plan delivers the observability + loud surfacing + cheap self-heal,
then a follow-up fixes the localized hop.

## Why `clientLog` is the right substrate

`clientLog` (`debug/plugins/logs/web/client-log.ts:21`) buffers lines and flushes
over a **plain HTTP `fetch` POST** to `/api/logs/emit` (debounced 250ms), which
appends to `~/.singularity/worktrees/<wt>/logs/<channel>.jsonl`. It is **fully
decoupled from the live-state WS** — so when that pipeline is wedged (the exact
failure), the trace logs still get through over HTTP. Readable with `cat`/`tail`,
survives refresh. This is the whole game: instrument over a transport that
survives the thing it watches.

## Architecture decisions

### 1. Extract a `log-channels` primitive (the layering fork — chosen: clean)

`clientLog` lives in the `debug/logs` *feature* plugin, but we need to log from
`live-state`, a load-bearing *primitive*. A core primitive importing a debug
feature inverts the layering. Boundary check confirms it'd be legal & cycle-free,
but we chose the clean route: **extract the persistent-log substrate down into a
new primitive `primitives/log-channels`**, leaving `debug/logs` as a thin viewer.

- **New `plugins/primitives/plugins/log-channels/`** owns the substrate end to end:
  - `core/` — `protocol.ts` (wire types) + `endpoints.ts` (`emitLogs`,
    `getLogChannels`, `EmitLogsBodySchema`, `EmitLogsBody`). *(moved verbatim)*
  - `server/` — `Log`, `listChannels`, `readChannelEntries`, `registry.ts`,
    `persist.ts`, `handle-emit.ts`, `handle-channels.ts`, `ws-handler.ts`, and the
    server plugin def (`httpRoutes` for `/api/logs/*` + `wsRoutes` `/ws/logs`).
    *(moved verbatim)*
  - `web/` — `clientLog` emitter (`client-log.ts`). *(moved verbatim)*
  - `lint/` — the `no-console-log` rule moves here too (it's about the logging
    substrate, not the debug pane). Repo-wide effect is unchanged.
- **`debug/logs` keeps only the viewer**: `panes.tsx` (`logsPane`,
  `logChannelPane`), `log-viewer.tsx`, the `DebugApp.Sidebar` nav item and
  `Pane.Register` contributions. It imports protocol types + `/ws/logs` +
  `getLogChannels` from the new primitive.

Consumer repoints (7 import sites; codegen barrels regenerate via build):

| File | Import | New source |
|---|---|---|
| `build/server/internal/build-log.ts:1` | `Log` | `@plugins/primitives/plugins/log-channels/server` |
| `conversations/transcript-retention/server/internal/touch-job.ts:3` | `Log` | …`/log-channels/server` |
| `database/migrations/server/internal/runner.ts:5` | `Log` | …`/log-channels/server` |
| `infra/attachments/server/internal/orphan-sweep.ts:5` | `Log` | …`/log-channels/server` |
| `build/web/components/build-button.tsx:9` | `clientLog` | …`/log-channels/web` |
| `build/plugins/build-logs/web/components/build-log-section.tsx:17` | core types | …`/log-channels/core` |
| `build/web/components/build-popover-content.tsx:16` | core types | …`/log-channels/core` |

`server.generated.ts` / `web.generated.ts` are autogen — regenerated by
`./equin build`, not hand-edited.

### 2. Networking must stay log-free (cycle avoidance)

`log-channels/web` depends on `networking` (clientLog's reconnect-flush uses
`subscribeWsStatus`). Therefore **`networking` must NOT import `clientLog`** — that
would form `networking ↔ log-channels`. The networking-layer hops
(`shared-websocket.ts`, `cross-tab-election.ts`) are instrumented by **publishing
transition events to an event bus**, which a subscriber *above* networking logs.

- Extend the existing status bus into a small **net-diagnostics bus** in
  `networking/web` (alongside `ws-status-bus.ts`): `publishNetDiag(ev)` /
  `subscribeNetDiag(fn)`, where `ev` covers socket lifecycle (`onopen`/`onclose`/
  `reconnect-scheduled`) and election transitions (`elected`/`demoted`/`steal`/
  `no-leader`/`follower-joined`). `networking` only *publishes*; it gains no log
  dependency.

Resulting edges (all DAG, verified against `boundary-config.ts` single
`plugin.** -> plugin.**` zone): `live-state → {networking, log-channels}`,
`log-channels → networking`. Nothing imports `live-state` back.

## Layer 1 — per-hop persistent tracing (the core deliverable)

Channel: **`live-state`** → `logs/live-state.jsonl`. Always-on for *anomalies and
transitions* (low-volume, exactly the failure signatures); successful per-frame
applies are gated behind a verbose flag to avoid spam.

Instrument **inside `live-state`** (`notifications-client.ts`), importing
`clientLog` from `@plugins/primitives/plugins/log-channels/web`:

- `observe` / `unobserve` (key, params, refcount).
- `sendSub` (key, params, socket) and `sub-ack` received (key, version).
- **DROP — missing sub** (`if (!entry) return`, ~line 249): log key, version,
  reason `no-sub`.
- **DROP — version guard** (`if (msg.version <= entry.version)`, ~line 251): log
  key, msg.version, entry.version, reason `stale-version`.
- **DROP — schema parse throw** (onmessage catch) and **JSON SyntaxError drop**:
  log key + error.
- `applyDelta` base-missing resub; `replaySubs` (count, socket) on reconnect.
- Stamp each tab line with `getTabId()` (`tab-id` primitive) for attribution.
- Successful `applyUpdate` (key, version) — **only** when verbose flag on.

Instrument the **networking layer via the diag bus** (no log import): publish
`onopen`/`onclose`/`reconnect-scheduled` from `shared-websocket.ts` and
`elected`/`demoted`/`steal`/`no-leader`/`follower-joined` from
`cross-tab-election.ts`. A tiny subscriber in `live-state` (mounted by
`NotificationsProvider`) forwards every diag event to `clientLog("live-state", …)`.

Verbosity gate: a `config_v2` boolean `liveState.verboseTrace` (default `false`)
read in the browser; anomalies/transitions ignore it (always logged).

## Layer 3 — loud watchdog (toast + deduped crash task)

A `Core.Root` no-render watcher (mirrors `health`'s `ReconnectWatcher`), added to
the **`health`** plugin (cohesive with its existing connection-health surfacing;
already `Core.Root`, already subscribes `subscribeWsStatus`). Detection is
push/transition-driven with armed timeouts (no polling):

- **Socket-down wedge.** On `subscribeWsStatus` `reconnecting`/`closed`, arm a
  ~15s timeout; if not cleared by `open`, fire `wedge("socket-down", url, elapsed)`.
- **No-leader wedge.** Subscribe to the new diag bus `no-leader` event (raised when
  a follower's leader-timeout fires and no open socket results); fire
  `wedge("no-leader")`.
- **Missed-updates wedge + self-heal.** On `document visibilitychange → visible`,
  call a new `NotificationsClient.resync()` (forces `replaySubs`). Compare each
  sub's pre-resync applied version to the returned `sub-ack` version; any positive
  jump while the tab was hidden/"open" proves missed frames →
  `wedge("missed-updates", key, from, to)`. The resync **also fixes** the stale
  cache (cheap self-heal). `visibilitychange` wired directly (no primitive exists).

On `wedge(...)`:

- `ShellCommands.Toast({ title: "Live updates stalled", description: "Reconnecting…
  refresh if data looks stale", variant: "warning" })` — transient; a per-watcher
  cooldown collapses flapping so toasts don't spam.
- `report({ source: "live-state-wedge", errorType: "LiveStateWedge", message,
  label: "live-state.watchdog", url, userAgent })` from `@plugins/crashes/web` —
  files a **deduped** crash task (crashes dedups by signature server-side; stable
  message/label ⇒ one task with a growing count). Add `"live-state-wedge"` to the
  `CrashSource` union in `crashes/shared/types.ts` (first-class, filterable) —
  aligns with the "crash on recoverable errors" guidance.

## Layer 2 — live "live-state health" inspector pane

New `plugins/debug/plugins/live-state-health/` (own sub-plugin per modularity),
contributing a `DebugApp.Sidebar` entry + pane. Shows, from new push-based
introspection:

- Per-resource rows: key, params, current applied version, last-update age
  (rendered via the `relative-time` primitive's `<RelativeTime/>` — it self-ticks,
  no manual timer), sub refcount, socket (worktree/central).
- Socket status (worktree + central) from `subscribeWsStatus`.
- Leader status: am-I-leader / is-there-a-leader / last-heartbeat age, from the
  diag bus.

Introspection API (no polling): `NotificationsClient.debugSnapshot()` returning
subs with `{key, params, version, lastAppliedAt, refcount, socket}` plus
`subscribeDebug(listener)` firing on any sub/version/socket/leader change; the
pane subscribes and re-renders. `CrossTabElection`/`SharedWebSocket` expose
`isLeader` / `hasLeader` / `lastLeaderSignal` / `readyState` getters.

This layer is the lowest-priority of the three (the JSONL trace already gives most
of it) — implement after Layers 1+3 prove out.

## Files

**Create**
- `plugins/primitives/plugins/log-channels/{core,server,web,lint}/…` (moved substrate + barrels + `package.json` + `CLAUDE.md`).
- `plugins/primitives/plugins/networking/web/net-diag-bus.ts` (+ export from networking barrel).
- `plugins/debug/plugins/live-state-health/{web}/…` (inspector pane).

**Modify**
- `plugins/debug/plugins/logs/**` — strip substrate, keep viewer; repoint imports to `log-channels`.
- `plugins/primitives/plugins/live-state/web/notifications-client.ts` — Layer-1 logging, diag-bus subscriber, `resync()`, `debugSnapshot()`/`subscribeDebug()`.
- `plugins/primitives/plugins/live-state/web/use-resource.ts` — wire diag subscriber into `NotificationsProvider`.
- `plugins/primitives/plugins/networking/web/{shared-websocket.ts,cross-tab-election.ts}` — `publishNetDiag(...)` at transitions; introspection getters.
- `plugins/health/web/**` — add the watchdog `Core.Root` watcher.
- `plugins/crashes/shared/types.ts` — add `"live-state-wedge"` to `CrashSource`.
- 7 consumer import sites (table above).
- `config_v2` schema — add `liveState.verboseTrace`.

## Verification

The bug is intermittent, so verification = boundary correctness + *induced*
failure, not waiting for the wild repro.

1. `./equin build` (regenerates barrels/migrations) then
   `./equin check plugin-boundaries` — confirm the extraction introduces no
   cycle and all edges are legal. Run `./equin check` (eslint, docs-in-sync).
2. **Decoupling proof:** with the app open, kill the notifications WS (DevTools →
   block `/ws/notifications`) and confirm `clientLog` still appends to
   `logs/live-state.jsonl` (HTTP path alive while WS is dead).
3. **Trace localizes a hop:** Playwright with two browser contexts (two tabs →
   leader + follower); close the leader tab to force handoff; mutate a resource
   server-side mid-handoff (e.g. flip a conversation status via the running
   agent). `cat logs/live-state.jsonl` shows the election transitions, the
   gap, and either recovery (`replaySubs` + `sub-ack`) or a drop — proving the
   trace pinpoints the dead hop.
4. **Watchdog fires:** force a sustained socket-down (>15s) and confirm the toast
   appears and a crash task is filed — verify with
   `query_db "SELECT id, error_type, label, count FROM crashes WHERE label='live-state.watchdog'"`.
5. **Missed-updates self-heal:** background a tab, mutate the resource while
   hidden, foreground it; confirm the badge updates *without* refresh and a
   `missed-updates` line is logged with a version jump.
6. Existing `Log`/`clientLog` consumers (build logs, migrations, attachments,
   transcript-retention) still write their channels after the move.

## Sequencing

1. **Part A** — extract `log-channels`, repoint consumers, build green. (Enabling
   refactor; no behavior change.)
2. **Layer 1** — tracing + net-diag bus. (Delivers the catch.)
3. **Layer 3** — watchdog (toast + crash). (Delivers loud + self-heal.)
4. **Layer 2** — inspector pane. (On-demand inspection; optional/last.)

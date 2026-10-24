# Host-saturation remediation — finish plan (WS-cut containment, log rotation, push-check latency)

**Companion to:** [`2026-07-08-host-saturation-agent-checks-starve-main.md`](./2026-07-08-host-saturation-agent-checks-starve-main.md)
(the confirmed root-cause investigation). Indexed in [`CLAUDE.md`](./CLAUDE.md).

## Context

The 2026-07-08 investigation confirmed (≈95%) that "main app slow + data doesn't
refresh" bursts are **host-level scheduler starvation**: concurrent agent
build/check fleets saturate the 18-core host; the single-threaded main backend
(default QoS, same tier as the storm) stalls to event-loop p99 950–1700 ms; the
notifications WS is cut every ~10–12 s and each reconnect replays ~116 live-state
subscriptions into the already-starved backend — a self-amplifying loop read by
the user as "stale data".

Two fixes landed on main (`2a7660401`): (1) type-check workers self-demote to
darwinbg at their spawn site unless `branch === "main"`; (2) the main backend
raises its event-loop thread to user-interactive QoS at boot (`isMain()`-gated).

This plan finishes the **scoped subset the user chose** from the investigation's
open items. Two open items are **explicitly deferred** (see "Out of scope").

**Scoping decisions (from the user, this session):**
- **A/B validation of the two landed fixes → deferred.** It needs a live
  saturation burst; there is none now (load ~10, main p99 healthy). Not forced
  this session.
- **Push-check latency → measure first, fix only if slow.**
- **This pass lands:** (1) WS-cut containment, (2) log rotation. Admission-control
  tightening and the pre-Jul-7 session sweep are **not** in this pass.

Both remaining code changes are **containment** (make the amplifier/disk-growth
not hurt), not cures for the host saturation itself — that is what the deferred
admission-control work and the already-landed priority fixes address. Naming the
altitude explicitly per the perfs-investigation method.

---

## Workstream 1 — WS-cut containment: set an explicit `Bun.serve` `idleTimeout`

**Root of the ~10–12 s cut (was open question 1 — now answered).** The
`reverse proxy error: EOF` lines in `gateway.log` come from Bun's **top-level
`Bun.serve` `idleTimeout`, whose default is 10 s** — *"a connection is idle when
no data is being sent or received, including in-flight requests where your handler
is still running but hasn't written any bytes to the response yet"* (Bun docs,
confirmed on the installed Bun 1.3.13). While the event loop is stalled, HTTP
handlers (health probes, HTTP loader fallbacks) and **WS-upgrade attempts** sit
blocked without writing a byte, and Bun drops them at ~10 s (the idle sweep is
grid-quantized ~4 s → nominal 10 s fires in ~(10, 14] s, matching the observed
"~10–12 s"). The EOF log line is emitted only by `newReverseProxy`'s
`ErrorHandler` (`gateway/worktree.go:1226`), wired to the **HTTP** proxy path;
the raw WS hijack path (`gateway/proxy.go` `handleWebSocket`) has no logging and
no deadline. The already-upgraded notifications WS is governed by the *nested*
`websocket.idleTimeout` (default **120 s**, unset here) — empirically confirmed
NOT to trip at 10–12 s. So the reconnect storm is driven by upgrade attempts
being silently dropped at the 10 s HTTP idle timer, not by the live WS itself.

Ruled out (with evidence): server heartbeat = `HEARTBEAT_MS = 20_000`
(`runtime.ts:895`) — a ping scheduler, never closes anything, and 20s ≠ 10–12s;
client (`notifications-client.ts` / `networking/.../shared-websocket.ts`) has **no**
no-ping watchdog — it only reacts to native `onclose` and reconnects with backoff
`[500,1000,2000,5000]`; the gateway imposes **no** idle deadline on the WS relay
(raw `io.Copy` both ways, no `SetReadDeadline`).

**Change (one site):** in `plugins/framework/plugins/server-core/bin/index.ts:221`,
add a top-level `idleTimeout` to the `Bun.serve<WsData>({ ... })` config.

```ts
Bun.serve<WsData>({
  unix: socketPath,
  idleTimeout: 60, // seconds. Was Bun's default 10s → a transient event-loop
                   // stall dropped in-flight HTTP handlers and WS-upgrade
                   // attempts, triggering the reconnect/resubscribe storm that
                   // amplifies the stall. This listener is a gateway-fronted unix
                   // socket; a genuinely dead HTTP conn still reaps within a
                   // minute. WS traffic is separately governed by the (unset,
                   // 120s-default) websocket.idleTimeout.
  fetch(req, server) { ... },
  websocket: { ... },
});
```

**Why 60 s (not 0 / not 120):** an explicit bound is preferable to disabling idle
reaping. 60 s sits above the gateway's base readiness timeout (`adaptiveTimeout`
base 15 s → max 90 s under load, `gateway/loadavg.go`) headroom-wise and well
above any healthy sub-second HTTP handler, so only a genuinely stalled handler is
affected — exactly the case we want to survive rather than drop. Tunable; 90 s
(matching the gateway's load-scaled max) is a defensible alternative.
Corroboration that Bun's idle timeout is a real factor here: `primitives/ndjson-stream`
already exists specifically to *"survive Bun's idle timeout"* on streaming
responses — raising the timeout only makes that path more robust, never less.

**Altitude:** containment. It removes the *amplifier* (premature drop → reconnect
herd → 116-sub replay into the starved backend), not the stall. State this in the
issue doc when it lands.

**Files:** `plugins/framework/plugins/server-core/bin/index.ts` (~L221).

---

## Workstream 2 — Log rotation on the log-channels substrate

**Problem.** `~/.singularity/worktrees/singularity/logs/live-state.jsonl` is 3.9 GB
with no rotation, growing ~4 lines/s steadily even when healthy (also feeds
`fseventsd` churn during bursts). The substrate has **zero** size management.

**Write path (single funnel).** Every persisted log line — browser `clientLog()`
ingress via `POST /api/logs/emit` (`handle-emit.ts`, up to `MAX_EMIT_LINES=500`
lines/request) **and** server `Log.channel(id,{persist:true}).publish()` — funnels
through exactly one function: `appendEntry()` in
`plugins/primitives/plugins/log-channels/server/internal/persist.ts:31-42`, which
does a synchronous `appendFileSync` per line and nothing else. This is the single
chokepoint to add rotation; no caller needs to change.

**Design — rotate inside `appendEntry`, byte-counter gated (no `stat` per line).**
A synchronous `statSync` on every append would double the syscall cost on an
already-synchronous hot path. Instead track an in-memory per-channel byte counter:

- Module-level `Map<string, number>` of channel → current live-file byte size.
- First write for a channel (or counter miss): seed from `statSync` once (tolerate
  ENOENT = 0).
- Each append: add the line's byte length to the counter. When it crosses the cap
  (`MAX_CHANNEL_BYTES`, e.g. **128 MB**), rotate then reset the counter to 0.
- **Rotation** = shift `channel.jsonl → channel.1.jsonl → channel.2.jsonl …` up to
  `KEEP=3` rotations (unlink anything past K), then the next `appendFileSync`
  recreates a fresh `channel.jsonl`. Use `renameSync` (atomic within a dir).

**Read-path compatibility (load-bearing naming constraint).** `listChannels()`
(`persist.ts:49-60`) lists `*.jsonl` and derives the channel id by stripping
`.jsonl`. Rotated files therefore must **not** be discoverable as their own
channels. Two viable schemes:
- `channel.jsonl.1` (suffix appended) — naturally excluded by `endsWith(".jsonl")`,
  so `listChannels` ignores rotated files for free. **Preferred** for that reason.
- `channel.1.jsonl` — ends in `.jsonl`, so `listChannels` would surface a bogus
  `channel.1` channel; requires an explicit `/\.\d+\.jsonl$/` filter in
  `listChannels`. Avoid.

→ **Use `channel.jsonl.N`.** Reuse `sanitizeChannel()` (the path-traversal guard)
for every filename constructed in the rotation helper — never a raw channel string.

**`readChannelEntries` (optional follow-up, note but do not block on it).**
`readChannelEntries()` (`persist.ts:73-94`) reads only the live `channel.jsonl`, so
a `tail`-N that spans a just-rotated boundary is truncated to the current file.
With a 128 MB cap the current file holds a very large tail, so this is acceptable;
if the `debug/logs` viewer needs history across a rotation, extend
`readChannelEntries` to fall back to `channel.jsonl.1…N` when the live file yields
fewer than `tail` lines. Not required for the disk-growth fix; call it out in the
plugin `CLAUDE.md`.

**Altitude & the deeper origin (record, do not fix this pass).** Rotation is the
**boundary invariant** — no log channel grows unbounded, for any writer, forever.
The *origin* of the 4 lines/s is the always-on tier of live-state tracing
(`trace()` → `clientLog("live-state", …)` at `notifications-client.ts:24-26`): the
high-volume per-apply line **is** correctly gated behind
`localStorage["liveState.verboseTrace"]` (`verboseTraceOn()`), but the
transition/drop tier (`observe`/`unobserve`/`sendSub`/`sub-ack`/`drop reason=…`) is
unconditional and was designed under a "low-volume" assumption that ~100 consuming
plugins × many tabs violates. Reducing that (e.g. a per-batch summary line during
`replaySubs` instead of `sendSub`×116) is a separate change with its own risk —
**out of scope here**; flag it as a follow-up in the issue doc so rotation isn't
mistaken for having addressed the emission rate.

**Files:** `plugins/primitives/plugins/log-channels/server/internal/persist.ts`
(add rotation helper + byte-counter, call inside `appendEntry`); brief note in
`plugins/primitives/plugins/log-channels/CLAUDE.md`.

---

## Workstream 3 — Push-check latency on E-cores (measure first)

**The concern (verified in code).** `workerDemotion()`
(`plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/index.ts:57`)
gates purely on `branch === "main"` → returns `backgroundArgv` (darwinbg, E-cores)
for **every** non-main branch. A `./equin push` runs its checks from an
agent worktree on a non-main branch (`push.ts` → `runChecksUnderPushSlot` →
`runChecks`), so **push-time type-check workers now run demoted on E-cores while
the user is actively waiting on the push**. This conflates two different
"user-is-waiting" cases: a non-main *build* is background agent work (correct to
demote); a *push* is user-waited even on a non-main branch.

**Step 1 — Measure (do this first, decide from data).** On this quiet host
(load ~10), quantify the E-core penalty on the type-check itself:
- Warm the caches (run `./equin build` once), then time the standalone check
  cold-ish and warm: `time ./equin check type-check` on this (non-main)
  branch → workers run **demoted**.
- Compare against an **undemoted** run of the same target. Cleanest isolation
  without shipping code: temporarily measure the worker under both argv forms —
  e.g. a throwaway local timing that spawns the worker with vs without
  `backgroundArgv([...])` — or run the demoted check under host contention to see
  the tail. Record wall-clock (demoted vs undemoted), warm and cold.
- Cross-check the existing push profiler timings (`createPushProfiler`) if a recent
  real push is in the profiling data (`debug/profiling` push pane).

**Decision gate.** If demotion adds a meaningful, user-visible penalty to push
checks (rule of thumb: > ~15–20% wall-clock, or seconds on the interactive push
path), proceed to Step 2. If negligible on E-cores for this workload, record the
measurement in the issue doc and **stop** (no code change).

**Step 2 — Conditional fix (only if slow): keep push checks at default priority.**
The push path is a distinct, user-waited flow and already runs its checks
*exempt* from the host build slot (`runChecksSubprocess` sets
`SINGULARITY_HOST_SLOT_HELD=1`). Extend that "this run is user-waited" signal to
demotion: thread a foreground flag from the push caller through `runChecks` to
`workerDemotion()` so push runs stay undemoted, while background agent builds still
demote at the source.
- Preferred shape: an explicit env flag (e.g. `SINGULARITY_CHECKS_FOREGROUND=1`)
  set by the push checks subprocess spawn, honored in `workerDemotion()`:
  `if (process.env.SINGULARITY_CHECKS_FOREGROUND === "1") return (argv) => argv;`
  before the branch check. This keeps the branch-based default for build/standalone
  runs and treats "push" as the explicit user-waited exception — the same idea as
  the existing `SINGULARITY_HOST_SLOT_HELD` nested-exempt signal, not a new coupling
  invented from scratch.
- Update the `workerDemotion()` comment (which currently justifies the gate purely
  as "same rule as build.ts's `branch === 'main'` exemption") to record that push
  checks are user-waited too.

**Files (only if Step 2 triggers):**
`.../type-check/check/index.ts` (`workerDemotion`),
`plugins/framework/plugins/cli/bin/commands/push.ts` (set the flag on the checks
subprocess spawn — near `runChecksSubprocess`).

---

## Out of scope (deferred — keep open in the issue doc)

- **A/B validation of the two landed fixes.** Needs a live saturation burst.
  Method when a burst next occurs: cross-backend control — main (QoS-boosted +
  demoted-source workers) vs an idle agent-worktree backend (unboosted) from each
  `health.jsonl` over the same minutes; confirm main's p99 stays low while the
  control stalls. Worker-demotion truth via `sudo launchctl procinfo <pid>` (NOT
  `ps -o ni`/`pri` — see the instrumentation trap in the issue doc). Caveat: with
  worker demotion landed the burst is milder, so the two fixes are entangled;
  isolating the QoS boost needs a burst that still saturates.
- **Admission-control tightening.** 4 build slots (`floor(cpus/4)`,
  `host-semaphore.ts:27-34`) × ~8 heavy children over-admits on 18 cores; the
  per-fleet memory guard (`type-check/check/index.ts:186-190`, `PER_WORKER_BYTES`)
  ignores *other* fleets. A host-wide memory-aware admission is the real fix.
- **Pre-Jul-7 agent-session sweep.** One-shot demote/restart of long-lived
  undemoted tmux sessions + a structural guard so inheritance gaps can't recur.

---

## Verification

1. **Build & checks:** `./equin build` (from this worktree), then
   `./equin check` — all checks green (type-check, plugin-boundaries,
   promise-safety, etc.). The rotation change is server code inside an existing
   primitive; no schema/migration.
2. **WS idleTimeout:** confirm the app serves normally at
   `http://<worktree>.localhost:9000` after build (a scripted Playwright load via
   `e2e/screenshot.mjs`). Sanity-check the WS stays connected > 20 s idle (healthy
   heartbeat path unaffected) — e.g. open the app, leave it idle, confirm no
   reconnect churn in `~/.singularity/worktrees/<wt>/logs/live-state.jsonl`.
   Full effect (no EOF storm under stall) only observable during a real burst —
   note as a burst-time re-check alongside the deferred A/B.
3. **Log rotation:** unit-test the rotation helper (`persist.test.ts`, `bun:test`,
   co-located) — write past the cap into a temp dir, assert `channel.jsonl` reset +
   `channel.jsonl.1..N` present + none past `KEEP`, and that `listChannels` still
   returns exactly `["channel"]` (rotated files excluded). Then live: lower the cap
   via a test, drive `POST /api/logs/emit`, confirm files rotate on disk.
4. **Push-check latency:** the timing runs in Workstream 3 Step 1 ARE the
   verification for that decision; record numbers (demoted vs undemoted, warm/cold)
   in the issue doc regardless of the outcome.
5. **Doc hygiene (non-negotiable, same turn as landing):** update
   `2026-07-08-host-saturation-agent-checks-starve-main.md` — mark open question 1
   answered (Bun 10 s top-level `idleTimeout`), record the idleTimeout + rotation
   fixes under "Implemented", and refresh the one-paragraph summary in
   `research/perfs/CLAUDE.md`.

## Critical files

- `plugins/framework/plugins/server-core/bin/index.ts` — `Bun.serve` `idleTimeout` (~L221).
- `plugins/primitives/plugins/log-channels/server/internal/persist.ts` — rotation in `appendEntry` (L31-42); read-path constraints `listChannels`/`readChannelEntries` (L49-94).
- `plugins/primitives/plugins/log-channels/CLAUDE.md` — document rotation + `readChannelEntries` follow-up.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/index.ts` — `workerDemotion` (L57) — only edited if Workstream 3 Step 2 triggers.
- `plugins/framework/plugins/cli/bin/commands/push.ts` — `runChecksSubprocess` foreground flag — only if Step 2 triggers.
- `research/perfs/2026-07-08-host-saturation-agent-checks-starve-main.md` + `research/perfs/CLAUDE.md` — doc updates.

# Op-status marker scan: stop freezing the flush cycle

## Context

The on-stall flight recorder (`singularity` `logs/stall-profiles.jsonl`) shows the
single most **frequent** real event-loop block is:

```
readdirSync ← listActiveWorktreeOps ← resolveActiveWorktreeOps ← loader ← … ← flushNotifies
```

**27 blocks** in the captured window, **~6 s avg, 9.3 s max**. This is the predicted
#1 event-loop block once `buildPluginTree` is fixed.

### Why it hurts (three lines of evidence agree)

1. **Code path.** `listActiveWorktreeOps()`
   (`plugins/infra/plugins/worktree/server/internal/worktree-op.ts:165`) does a
   **synchronous** `readdirSync` over the worktrees dir, then a `readdirSync` over
   each of ~18 slugs' `ops/` dir, plus a `readFileSync` + `process.kill(pid,0)` per
   marker. `resolveActiveWorktreeOps()` (`:340`) then adds `readPushHolder()`
   (`readFileSync`) and `pushLockHeld()` (`openSync` + FFI `flock` + `closeSync`).
   All synchronous.

2. **Where it runs.** That function is the op-status resource loader
   (`plugins/conversations/plugins/conversation-view/plugins/op-status/server/internal/resource.ts:25`),
   which executes inside `runFlushCycle` in the shared live-state runtime
   (`plugins/framework/plugins/resource-runtime/core/runtime.ts:1302`). The flush
   cycle is the **single serialization point for every live-state resource**. JS is
   single-threaded, so even though `runFlushCycle` runs each depth level via
   `Promise.all(level.map(drainEntry))`, a **synchronous** syscall inside one
   loader monopolizes the one thread — no other resource's loader, no `ws.send`, no
   HTTP handler, no heartbeat can run until it returns. The 6 s is mostly kernel IO
   **wait** on a contended host (18 worktrees + embedded Postgres + concurrent
   builds): the `readdir` is a **victim of host load, not intrinsically slow**, so
   "make the readdir cheaper" is the wrong axis.

3. **On-disk facts (the rate origin).** The watcher
   (`op-status/server/internal/watcher.ts`) watches the **entire** `WORKTREES_DIR`
   tree for **any** `.json` change and fires `worktreeOpsResource.notify()`
   unconditionally (`onChange: () => notify()`). But only
   `<slug>/ops/{build,push,check}.json` are op markers. That same tree also holds
   `build-profile.json`, `build-logs.json`, `release-logs-<id>.json` (see
   `plugins/infra/plugins/paths/core/internal/paths.ts:65` `worktreeArtifacts`) and
   gateway `<slug>.json` registration files — **rewritten repeatedly during every
   build**. Each such unrelated write fires `notify()` → a full synchronous
   18-worktree re-walk → a **no-op push** (the resource is `mode: "push"`, so it
   ships the whole `{slug→op}` map with no diff). The op markers themselves only
   change ~twice per build (write at start, clear at end), so the 27 occurrences are
   dominated by build-artifact JSON churn, **not** by real op-state changes.

### Root causes at two altitudes (fix both)

- **Rate origin (primary):** the watcher recomputes op state on filesystem events
  that *cannot* change op state. Illegitimate work — the methodology says the fix is
  to *not do it*, not to do it more cheaply.
- **Cost / boundary invariant (structural):** synchronous IO runs inside the shared
  flush cycle, so *any* occurrence — even a legitimate build start/stop under IO
  contention — freezes the whole event loop. The durable invariant is **"a resource
  loader must never do synchronous IO."**

Landing only the rate fix still leaves a legitimate marker change able to freeze the
loop; landing only the async fix still wastes a full walk + no-op push on every
artifact write. Prefer both: the rate fix makes the wasted work *not happen*; the
async fix makes the remaining real work *not block*.

## Scope check — the change is contained

- `resolveActiveWorktreeOps` is called **only** by the op-status loader.
- `listActiveWorktreeOps` is called **only** internally by `resolveActiveWorktreeOps`.
- ⇒ Converting both to async touches **no other call site**.
- `isWorktreeOpActive` (single-slug, one `readdir` + ≤3 file reads) is used by the
  tmux status poller (`runtime-tmux/.../tmux-runtime.ts:570,605`) and the push
  profiler — **not** in the flush cycle. **Left unchanged** (noted as a follow-up).

## Plan

### 1. Rate origin — filter the watcher to op-marker paths only

File: `plugins/conversations/plugins/conversation-view/plugins/op-status/server/internal/watcher.ts`

`createFileWatcher`'s `onChange` already receives `parcel.Event[]` with `.path`
(`plugins/infra/plugins/file-watcher/server/internal/create-file-watcher.ts:48`) —
the current handler just discards it. Change it to notify **only** when at least one
changed path is an op marker, i.e. its parent directory is `ops/`:

```ts
import { basename, dirname } from "node:path";
// …
const isOpMarker = (p: string) => basename(dirname(p)) === "ops";
// …
onChange: (events) => {
  if (events.some((e) => isOpMarker(e.path))) worktreeOpsResource.notify();
},
onReconcile: () => worktreeOpsResource.notify(),
```

- Precisely matches `<slug>/ops/*.json`; excludes `<slug>/build-profile.json`,
  `build-logs.json`, `release-logs-*.json`, and gateway `<slug>.json` (all sit
  directly under `<slug>/`, so their parent dir is the slug, not `ops`).
- Keep `onReconcile` firing `notify()` unconditionally — it is a rare (30 s) watcher
  **reliability backstop** for events parcel may drop, not a change poll. Once the
  scan is async this is a cheap safety net.
- The `.json` `extensions` filter stays (still correct — markers are `.json`).

### 2. Cost / boundary — make the marker scan async (no sync IO in the loader)

File: `plugins/infra/plugins/worktree/server/internal/worktree-op.ts`

Convert the scan path used by the loader to `node:fs/promises`, so a slow scan yields
the event loop (IO runs on the libuv threadpool) and blocks only op-status delivery,
never the shared flush cycle:

- Add an async `readLiveMarker` (uses `readFile` from `node:fs/promises`; keep the
  dead/garbage **reaping** — `rmSync`/`rm` — as is: it only fires for dead markers,
  and the write/clear TOCTOU already exists in the sync version, so async does not
  worsen correctness).
- Convert `listActiveWorktreeOps` → `async`: `readdir` the worktrees dir
  (`withFileTypes`), then scan each slug's `ops/` dir. Parallelize per-slug reads
  with `Promise.all` for lower wall-clock latency (bonus, not required for
  correctness).
- Convert `readPushHolder` → async (`readFile`) and `pushLockHeld` → async open
  (`open` from `node:fs/promises`, then the fast non-blocking FFI `flock` probe on
  the fd, then close) so the loader has **zero** synchronous IO. `isPidAlive`
  (`process.kill(pid,0)`) is a signal syscall, not IO — keep it sync.
- Convert `resolveActiveWorktreeOps` → `async`, `await`-ing the above.
- Keep the **sync** `isWorktreeOpActive` / sync `readLiveMarker` / sync
  `readPushHolder` variants for the non-flush-cycle callers (tmux poller, push
  profiler), or refactor them to share an internal helper — implementer's choice, but
  do **not** force those synchronous callers async.

File: `op-status/server/internal/resource.ts`

The loader already supports `Promise<T>` (`ResourceDefinition.loader` returns
`Promise<T> | T`). Change it to `loader: async () => { … await resolveActiveWorktreeOps() … }`.
No other change — the flush cycle already `await`s the loader.

### 3. (Optional, noted) secondary no-op-push amplifier

The resource is `mode: "push"`, so every trigger (incl. the 30 s reconcile) ships the
full map to all subscribers with no equality check. After (1) this is rare, so it is
**out of scope** for this change. If it later shows up in the live-state-churn
monitor, add a value-equality guard or move op-status to a keyed/diffed resource —
tracked separately, not done here.

## Files to modify

- `plugins/conversations/plugins/conversation-view/plugins/op-status/server/internal/watcher.ts`
  — path-filter `onChange`.
- `plugins/infra/plugins/worktree/server/internal/worktree-op.ts` — async
  `listActiveWorktreeOps` / `resolveActiveWorktreeOps` / `readPushHolder` /
  `pushLockHeld` / async `readLiveMarker`; keep sync variants for other callers.
- `plugins/conversations/plugins/conversation-view/plugins/op-status/server/internal/resource.ts`
  — `await` the now-async resolver.
- (Docs) `plugins/framework/plugins/resource-runtime/CLAUDE.md` — record the invariant
  "resource loaders must never do synchronous IO (it freezes the shared flush cycle)."

## Structural follow-up (surface, don't memorize)

Per the repo's "fix the structural issue" rule, this class — *synchronous IO reachable
from a live-state loader freezing the whole flush cycle* — should be prevented, not
just patched here. **File each as an equin task via the `add_task` MCP tool during
implementation** (not part of this change's diff):

- A lint rule or `./equin check` that flags `*Sync` `node:fs` calls in server
  resource-loader / `defineExternalResource` code paths, and
- Converting the single-slug sync `isWorktreeOpActive` used by the tmux poller to
  async so per-pane polling can't block its runtime either.

## Verification

1. `./equin build` (from this worktree), confirm it boots clean.
2. **Rate fix** — confirm artifact churn no longer triggers op-status:
   - Open a conversation with the op-status banner visible
     (`http://<worktree>.localhost:9000/...`).
   - Trigger a build in some worktree (writes `build-logs.json`/`build-profile.json`
     repeatedly). Watch the live-state-churn / no-op-push surface
     (Debug → Reports / Live-State) and the `worktree-ops` loader call count in the
     runtime profiler (`get_runtime_profile` MCP / Debug → Gantt runtime tables):
     the op-status loader should fire ~twice per build (marker write + clear), **not**
     on every artifact write.
   - Confirm the banner still correctly shows `Building` at start and clears at end
     (real marker events still flow through `isOpMarker`).
3. **Cost fix** — confirm no event-loop block:
   - With builds running across worktrees, watch Debug → Health (event-loop lag) and
     re-check `stall-profiles.jsonl`: the `readdirSync ← listActiveWorktreeOps` block
     should be gone (the scan is now async; any residual wait attributes to op-status
     delivery latency only, not an event-loop stall).
   - Use `benchmark_boot` / the push Gantt to confirm `flushNotifies` is no longer
     head-of-line-blocked by `worktree-ops`.
4. Sanity: a live push still shows `Pushing` / `Waiting for lock` correctly (the
   derived push-phase logic in `derivePushPhases` / `readPushHolder` / `pushLockHeld`
   is behavior-preserving across the async conversion).

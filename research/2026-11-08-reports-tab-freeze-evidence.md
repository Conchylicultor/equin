# A tab freeze must say which task froze it

Task: task-1794150856-s3qbja / its re-file (audit `2026-11-08-global-app-health-24h-after.md` §6 item 18).

## The 243.9 s freeze (report-1794148414-iljir1)

- Tab `51c2c991…`, `prototypes` / `prototypes-detail`, `/prototypes/proto/proto-1792836852-pvwo12`,
  focused and visible, 14:29:29Z → 14:33:33Z, ended `gone` (the user reloaded), no cohort (other
  tabs answered: not a machine-wide stall).
- The audit said "no long-animation-frame entry was recorded". **That is wrong**: the report holds
  a `stallFrame` covering all 243,898 ms, one script: `MessagePort.onmessage` at
  `primitives.networking.web.25c36892d036bd92/index.js:7635`.
- That position (read from the content-addressed artifact) is
  `n.port.onmessage = (e) => this.onWorkerMessage(n, e.data)` in `shared-websocket.ts`: the tab end
  of the shared live-state socket. **Every** live-state frame enters there (`rx` →
  `NotificationsClient` `onmessage` → `handleServerMessage`), and LoAF counts the microtasks the
  handler queued in that same script time.
- React Query notifications are not in it: they run in `runQueued`, a separate `setTimeout` task
  (`coalesced-notify.ts`). So the freeze was inside the frame's own handling, or a microtask chain it
  started.
- **Which frame is unknowable from what was recorded.** The tab's `live-state.jsonl` lines stop at
  14:28:22.6 (they show a gallery → detail navigation), so its last 67 s were never flushed. The
  server logs nothing per frame. Reopening the prototype in a headless tab did not freeze it.
- Same blind spot elsewhere: the 106 s `files-at` freeze (report-1793971284-ocnqh9) is blamed by
  LoAF on the stall detector's own watchdog port handler, and the 12.8 s `places` ones the same.

**Root cause: not found. The recorded data cannot name it.** The fix below makes the next one
name it.

## Design: marked tasks

LoAF names a frozen frame's entry point, never what that entry point was doing. So the entry point
says what it is about to do, to a thread that is not going to freeze:

- `primitives/perfs/task-marks`: `runMarked(source, describe, fn)`. The one listener hears
  `begin(source, describe) → id` before `fn`, and `end(id)` one microtask after it returns or
  throws (so microtasks `fn` queued itself count as part of it). Only the outermost marked task is
  heard. With no listener it is just `fn()`.
- The listener is `main-thread-stall`'s tab watch. It posts `mark {id, at, source, what, detail}` /
  `mark-end {id}` to the SharedWorker watchdog, only while attached and visible. `postMessage`
  reaches the worker's thread at once, so a frozen task's begin is already there.
- The machine keeps each port's **open** mark (an end closes it only with a matching id).
  `frozenIn` is the primary tab's open mark **at stall onset**. Nothing runs between the freeze and
  the onset, and whatever the tab runs once it is back is not the freeze. The payload also gets
  `marks` (the latest 20 from 10 s before the stall to its end), and the fingerprint gets
  `|source:what`. The task text, the summary and the Debug → Reports row show it.
- Marked: every live-state frame (`what` = `<kind> <resource key>`, `detail` = bytes plus params,
  each value capped before joining), and every watchdog message the tab half handles
  (`main-thread-stall`, `<kind>`).

### Rejected: a time window

The first version picked "the last mark begun after the last answered ping, inside the frozen frame
or within PING_MS of the answer". The e2e showed it is wrong in practice. A `setTimeout` endless
loop was blamed on `update db-lock-watch`, a live-state frame that had *finished* a moment before
it. Frames arrive about every second, so this is the common case, not an edge. Closing marks
explicitly removes the ambiguity, so the window is gone.

### Cost

- Per visible frame: two small structured-clone posts plus a capped label. There is no per-frame
  work while the tab is hidden or unattached, and none at all without a listener.
- A 500-frame boot burst is about 1,000 posts of a few µs each.
- Rejected for now: the JS Self-Profiling API. It needs a `Document-Policy` header, costs CPU in
  every tab all the time, and its samples die with a `gone` tab, which is exactly the case here.

## Verification

- `stall-machine.test.ts` / `task-marks.test.ts`, 41 tests. They cover the 2026-11-08 shape, a
  finished mark before an unmarked freeze (not blamed), recovery tasks before the pong (not
  blamed), a late end of an earlier task, the persisted open record, and nesting and throwing in
  `runMarked`.
- `e2e/freeze.ts`, 17 checks against the deploy:
  - a real 8 s freeze inside a real live-state frame files a report whose `frozenIn` is
    `live-state` and whose fingerprint carries it;
  - the three unmarked injected loops (recovered, gone, unknown) name no frozen task.

## Not covered

- A freeze outside every marked entry point still names only LoAF's entry point: React's scheduler
  task, timers, rAF loops, the prototype frame channel's port. Those are mostly named functions
  already.
- A freeze deeper in a promise chain than the microtasks `fn` queued itself starts after the end
  and reads as unmarked.

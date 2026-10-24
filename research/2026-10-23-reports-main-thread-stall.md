# Browser main-thread stall detector (design, for discussion)

## Context

On 2026-10-23 the Agent Manager tab froze twice during a demo (~20:20:11→20:21:27 and
~20:31:35→20:32:33). Both freezes ended in a manual reload, and neither alerted anywhere.
In `logs/live-state.jsonl`, tab `57795d8d…` goes silent after 20:20:11 while the other
tabs keep logging. Both freezes started right after the conversation sidebar's Queue
mounted. The only knock-on records were a 55 s `element edited-files` slow-op and a 41.7 s
`page-load` slow-op. Once a page has loaded, nothing watches the browser main thread:
long tasks are observed only by `perfs/boot-trace` (whose observer never disconnects and
grows an uncapped array) and by e2e harnesses. This breaks the debug skill's front-door
invariant: a durable failure had to be found by hand.

**Goal.** Every main-thread stall in a visible tab becomes a Report and a Timeline span.
The record says which tab, app and route stalled, for how long, how it ended (recovered,
reloaded or closed, or killed), which co-tenant tabs froze with it, and what code ran when
that can be known. The detector itself must cost close to nothing.

## The core constraint: a frozen thread cannot report itself

Every in-tab signal (long tasks, LoAF, a timer drift check) is delivered after the frame
ends. A freeze that never ends, like both of these, produces none of them. The watcher
therefore has to live on another thread.

The repo already runs a **SharedWorker** (`primitives/networking/web/shared-websocket.ts`)
and uses Web Locks for port liveness. That proves the substrate works here. Its lock
signal only tells the worker that a tab is gone; a frozen tab still holds its lock.

### Design: an out-of-thread watchdog plus in-tab attribution

```
 tab main thread                           stall-watchdog SharedWorker (own thread)
 ───────────────                           ───────────────────────────────────────
 on 'ping' → post 'pong'  ◄── ping 1 Hz ── one timer for all ports; only while ≥1 visible port
 visibility/freeze/route → post 'state' ─► per port: {tabId, app, route, visible, lastPong, crumbs}
 LoAF ≥200 ms → post 'frame' (attrib) ───► crumbs ring (last 10 long frames)
 holds Web Lock per port ────────────────► lock released ⇒ tab gone (reload/close/kill)

 pong age > 2 s  → stall OPEN  → IndexedDB put {open stall}   (1 write; survives the worker dying)
 pong resumes    → stall END(recovered)  ┐
 lock released   → stall END(gone)       ├─► if dur ≥ 5 s: POST report + slow-op, then IDB delete
 worker boot     → drain leftover IDB    ┘   (end = unknown, "≥ lastPong…death")
```

- **When the tab recovers on its own**, the worker sees the pongs come back and closes
  the stall. The tab's own LoAF entry for that frame arrives right after and is the
  definitive attribution: scripts, `sourceURL`, `sourceFunctionName`, `invokerType`, and
  forced-layout time. The worker waits up to about 2 s for that entry and then files the
  stall with it.
- **When the tab never recovers but is reloaded or closed**, the Web Lock is released. The
  worker closes the stall as `ended: "gone"` and files it with its breadcrumbs: the route
  and app, the last long frames before the freeze, and whether *any* frame completed during
  the stall. A render storm still produces LoAF entries; an endless synchronous task
  produces zero. That difference is diagnostic on its own.
- **When Chrome kills the renderer, or the last tab closes and the worker dies with it**,
  the IndexedDB record of the open stall survives. The next worker boot drains it and files
  the stall with `ended: "unknown"` and a lower bound on the duration. `tabId` is stored in
  sessionStorage and survives a reload, so the drained record can name the tab that came
  back.
- **When several tabs share one renderer and freeze together** (as at 20:31:38), the
  worker sees them go stale within about one ping. It files **one** incident: the
  visible/focused tab is primary, and the others are listed as a `cohort`. This avoids N
  duplicate reports. A shared renderer also tells you the cause is in one of them; the
  others are victims.

### Why a dedicated worker rather than the shared-ws worker

The networking worker owns transport. Filing reports from it would make networking depend
on reports. The watchdog is about 150 lines with its own lifecycle, so it lives in its own
plugin. Its cost is one extra worker thread per origin, about 1–2 MB.

## Perf budget

| | Idle (no stall) | During a stall | Notes |
|---|---|---|---|
| Worker | 1 timer at 1 Hz, paused when no port is visible | same | One timer for all tabs, not one per tab |
| Tab main thread | 1 pong per second, a few µs, well under 0.01 % CPU | none (it is frozen) | |
| LoAF observer | callbacks only for frames over 50 ms; posts only frames ≥ 200 ms | the entry arrives on recovery | LoAF is designed for always-on RUM; attribution is collected by the browser |
| Memory | about 1–2 MB for the worker, plus a 10-entry ring per tab | | |
| Writes | **zero** | 1 IndexedDB put at onset, then 1 report POST, 1 slow-op POST and 1 IndexedDB delete at the end | |

**Always on:** the pong watchdog, the LoAF observer, and breadcrumbs (route, app,
visibility, recent long frames).

**On demand only:** JS stack sampling. The JS Self-Profiling API needs a `Document-Policy:
js-profiling` header and costs several percent always-on. A frozen tab cannot call `stop()`,
so it would never help with a freeze that never ends. It belongs in a "re-arm with profiler"
Debug toggle, or in an e2e reproduction under the render-profiler or CDP. It does not
belong in the always-on detector.

The boot-trace observer also gets fixed: it should disconnect, or cap its array, after the
boot window. Today it grows for the whole life of the page.

## Thresholds, dedupe, noise

- **A stall opens** when the last pong is more than 2 s old. The detector's precision is
  about ±1 s.
- **A report** is filed for a stall of **5 s or more**. Stalls from 1 to 5 s that recover
  are found by the tab's LoAF observer and go to the existing **slow-op** queue
  (`operationKind: "main-thread"`). They show on the Timeline as intervals and feed Slow
  Events aggregates without ringing the bell.
- **Every report-level stall also files a slow-op** for `[start, end]`. The Timeline then
  draws it as a span for free, through the existing slow-op source. The report is the
  alert; the slow-op is the interval.
- **Fingerprint**: app, route *pattern* (not ids), and the top attributed function when
  one is known, otherwise `unattributed`. The same freeze on the same screen dedupes into
  one row with a `count`. The latest `data` (duration, cohort, frames, end kind) is
  overwritten on each sighting, which is what the engine's upsert already does.
- **Noise and suppression:**
  - A tab that is hidden at onset is not reported. Chrome throttles and freezes background
    tabs, so the tab posts its `freeze`/`resume` lifecycle events and visibility to the
    worker, and the worker skips them. It still writes a `clientLog` line.
  - **Sleep or resume:** if the worker's own tick arrives more than 3 s late, the host or
    the machine stalled, not the tab. The worker resets every port's `lastPong` and files
    nothing.
  - **A DevTools breakpoint pause** cannot be told apart from a freeze. A `ReportNoiseRule`
    marks a stall noise when the tab ran on a dev build with DevTools likely open. **Open
    question**: or accept the noise. It only affects developers.
- **Report severity:** add the kind to `CRASH_LIKE_REPORT_KINDS` so the stall shows red on
  the Timeline, because a frozen UI is user-visible breakage.

## Shape (mirrors `reports/plugins/render-loop`)

`plugins/reports/plugins/main-thread-stall/`
- `core/`: payload schema (`tabId`, `app`, `routePattern`, `url`, `startedAt`,
  `durationMs`, `ended: recovered|gone|unknown`, `framesDuring`, `frames[]` with LoAF
  script attribution, `cohort[]`, `visible`), the fingerprint, and the constants.
- `web/`: a `Core.Root` controller. It connects the port, answers pings, posts
  state/route/freeze events, runs the LoAF observer, and drains IndexedDB on boot (as a
  fallback if the worker cannot). It also contributes `Reports.KindView` (the summary line
  plus a frames table).
- `web/` worker file: `stall-watchdog.worker.ts`. It files through the same
  `submitReport` and `submitClientSlowOp` endpoints over `fetch`.
- `server/`: `ReportKind({ kind: "main-thread-stall", … })`, with `renderTask` for the
  investigation prompt.
- `reports/core/sources.ts`: a new source `client-main-thread-stall`.
- `debug/timeline/server/internal/severity.ts`: the kind is added to the crash-like set.
- `perfs/boot-trace/web/internal/store.ts`: bound the observer to the boot window.

Reuse: `report()` / `submitReport` (`reports/web/report.ts`), `submitClientSlowOp`
(`debug/slow-ops/shared/endpoints.ts`), `getTabId()` (`scope/tab-id`), `clientLog` for
near-miss lines, and the Web Locks port-liveness pattern from
`networking/shared-websocket.ts`.

**Fallback when `SharedWorker` is missing** (some hosts): the detector runs in-tab only.
It catches recovered stalls through LoAF and a drift check, records "open stall" in
sessionStorage with a lastAlive timestamp, and the next load files it. That loses the
`gone` vs. `killed` distinction, but no freeze stays silent.

## Verification

1. A new e2e script, `main-thread-stall/e2e/freeze.ts`, runs against my build:
   - `while(Date.now()<t+8000){}` must give one report with `ended: recovered`, LoAF
     attribution naming the injected function, and a slow-op span on `get_timeline`.
   - An infinite loop followed by a page reload must give `ended: gone` with
     `framesDuring: 0`.
   - Two same-origin tabs, one frozen, must give a single report.
   - A hidden tab frozen must give no report.
2. `./equin test` on the pure parts: the stall state machine is a reducer over
   `{ping, pong, lockGone, tick}` events, so sleep, cohort and threshold rules are unit
   tested without a browser.
3. Idle cost check: Performance panel or `get_runtime_profile` with three tabs idle for
   60 s. Expect about 60 pongs per tab and no network writes.

## Implementation notes (2026-10-23) — where the build deviates from the above

Shipped as `plugins/reports/plugins/main-thread-stall` (see its CLAUDE.md). The
settled decisions: dedicated worker; thresholds 2 s / 5 s / 1–5 s slow-op; DevTools
pauses accepted as noise (no noise rule); the 1 Hz ping is a sanctioned clock (no
lint rejected it, so no exemption was needed); stack sampling out of scope.

- **The worker never POSTs.** A worker chunk must be self-contained (the page's
  import map does not reach workers; the web-artifacts audit enforces it), so it
  cannot use `submitReport` / `submitClientSlowOp`. It hands each finished stall to
  a live tab (the stalled tab's own id first, then a visible one), which files it
  with `report()` and acks; with no live tab it waits for the next attach. The
  slow-op goes through a new public `clientSlowOpSink` in `debug/slow-ops/core`
  (the queue and endpoint stay slow-ops-private), whose items may carry `endedAt`
  so a span filed after the fact lands at its true instant (the client item
  schema gained an optional `endedAt` → `occurredAt`).
- **IndexedDB writes**: not at onset but when an open stall crosses 5 s, then at
  each doubling of its age (a lower bound within 2× for `unknown`), plus one put
  when it finishes and one delete on the ack. Each record names its owner
  watchdog, which holds a lifetime Web Lock; a booting watchdog adopts only
  records whose owner's lock is free — so two builds' watchdogs (one per script
  URL) never steal each other's open stalls.
- **A recovered stall settles 2 s before filing**, even when its LoAF entry
  arrives first: a hung tab that is reloaded or closed has its script terminated
  by Chrome, answers one ping, then goes. That is `gone` (attributed — the
  terminated frame's LoAF names the loop), not `recovered`.
- **The watchdog dies with the renderer it runs in** (Chrome hosts a SharedWorker
  in the first client tab's process). Killing that tab's hung renderer kills the
  watchdog: its stall is filed `unknown` by the next one, and every other tab
  re-attaches (it queues for the watchdog's lifetime lock after a `hello`). So a
  `gone` vs `unknown` split partly reflects which tab hosted the watchdog.
- **Cohort members stay `covered`** after their incident ends until they answer
  again, so a still-frozen victim neither opens a second incident nor is handed a
  stall to file.
- **Fingerprint**: `main-thread-stall:<app>|<pane ids joined by />|<topFunction or
  unattributed>`, where `topFunction` (`fn (invoker)` of the longest LoAF script)
  is computed once by the machine and carried in the payload.
- **KindView** is the one-line list summary only (the slot renders one line per
  row); the frames table lives in the investigation task text.
- **e2e**: headless Chromium cannot reload or close a hung tab (it waits on the
  renderer forever, holding its locks), so `e2e/freeze.ts` kills the renderer
  with CDP `Page.crash` instead of reloading. It covers recovered (attributed),
  gone (a second tab killed; filed through the first) and unknown (the watchdog's
  host killed; filed by the next start). It needs `--no-record`: the harness
  screencast never returns on a hung page. Not covered: hidden-tab suppression
  and the two-tab cohort (unit-tested in `stall-machine.test.ts` only).
- **boot-trace**: the long-task observer disconnects at the first long task
  after the boot window (FCP and first commit both known) and caps at 500 entries.

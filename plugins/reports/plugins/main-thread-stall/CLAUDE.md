# main-thread-stall

Every main-thread stall of a visible browser tab becomes a `main-thread-stall`
report (the alert) and a `main-thread` slow-op (the Timeline span). Design:
[`research/2026-10-23-reports-main-thread-stall.md`](../../../../research/2026-10-23-reports-main-thread-stall.md).

## A frozen thread cannot report itself

So the watcher lives on another thread: `web/stall-watchdog.worker.ts`, ONE
SharedWorker for every tab of the origin (per build). It pings each tab at
1 Hz; each tab (`web/internal/tab-watch.ts`, mounted by the Core.Root
controller) answers, holds a Web Lock for its port (granted to the worker ⇒ the
tab is gone), and keeps the worker told where it is — app, route pattern (pane
ids, no params), url, visibility, focus, Page Lifecycle freeze — plus every
LoAF long frame ≥ 200 ms with its script attribution. A frozen tab cannot
update any of this later, so its last word must already be current.

The 1 Hz timer is a sanctioned exception to "no polling": the signal is an
ABSENCE, which only a clock can see (precedent: the server health monitor's
event-loop sampler). It runs only while a visible tab is attached or a stall is
in flight.

## The decisions are one pure machine

`web/internal/stall-machine.ts` is a reducer over `attach / state / pong /
frame / mark / mark-end / interaction / interaction-end / gone / tick /
clock-stopped / filed / adopt` returning effects
(`ping / persist / forget / deliver / log`); the worker only carries them out.
All rules live (and are tested) there:

- **Open** at 2 s without a pong; **report** at ≥ 5 s. A recovered stall
  *settles* 2 s before filing: its LoAF entry (the definitive start, duration
  and attribution) arrives, and a tab that answered only because a reload /
  close made Chrome terminate its script goes away — that is `gone`, not
  `recovered`. Filed only if the final duration is ≥ 5 s. Long frames 1–5 s
  are filed by the tab itself as slow-ops only.
- **Ended**: `recovered`, `gone` (lock granted: reload, close, kill),
  `unknown` (the worker died with it open — see storage).
- **Suppressed**: a tab hidden or Page-Lifecycle-frozen at onset (logged once).
- **Sleep**: a worker tick > 3 s late resets every tab and drops open stalls.
- **Cohort**: tabs silent within 1.5 s of each other froze together (one
  renderer): one incident, the focused visible tab primary, the others
  `cohort[]`; they stay `covered` (no second incident) until they answer.
- **Frames are placed by when they ran, not when they arrived** (LoAF entries
  land late, often after the pong): one ≥ 2 s overlapping the stall is the
  `stallFrame`; shorter ones inside it are `during` (the longest 10, counted
  in `framesDuring`); `frames` (breadcrumbs) are only those that ended within
  10 s before the stall began — never the freeze itself.
- **Fingerprint**: the interaction's target when a user interaction started
  the freeze (see below); otherwise app + route pattern + top attributed
  function — the
  `stallFrame`'s, else the function with the most script time across `during`
  when those frames cover ≥ half the stall (else `unattributed`: silence no
  long task fills is most likely a renderer starved of CPU, not app code). DevTools breakpoint pauses are accepted as noise.

## A task says what it is before it runs

LoAF names a frozen frame's **entry point** only — and an entry point such as
the shared socket's port handler runs every live-state frame, so "(anonymous)
(MessagePort.onmessage)" in `primitives/networking` says nothing about which
frame froze the tab (the 243.9 s prototypes freeze of 2026-11-08). So entry
points run as **marked tasks** (`primitives/perfs/task-marks`:
`runMarked(source, describe, fn)`; live-state marks every frame as
`<kind> <key>`, params and size as detail), and the tab watch posts each
begin and end to the watchdog as they happen — `postMessage` reaches the
worker's thread at once, so a task that freezes the thread leaves its mark
open there. Only while attached and visible; `describe` never runs otherwise.

- `frozenIn` is the tab's **open** mark when the stall opened (begun, no
  `mark-end`): nothing runs between the freeze and the onset, and what the tab
  runs once back is not the freeze. A marked task that finished just before an
  unmarked freeze is closed, so it is never blamed (a time window did: the
  first e2e run blamed `update db-lock-watch` for an injected setTimeout loop).
  Null: the tab froze outside every marked task.
- `marks`: the latest (≤ 20) from 10 s before the stall to its end.
- A mark is not a sign of life (a render storm still begins tasks).
- The fingerprint appends `|<source>:<what>` of `frozenIn` when set.

## A freeze a click started names the click

The most severe freezes a person causes start from a click or key press, and
an app + route + function key cannot trace them back to it. So the tab tells
the watchdog about every trusted interaction **at dispatch** — from the
slow-interaction capture listener, before any handler runs: `interaction`
(its target, resolved exactly as a slow interaction's, plus event type and
epoch) — and `interaction-end` once its next paint has happened (rAF, then the
first task after it). Only while attached and visible, like marks.

- `interaction` on the payload is the primary's **unpainted** interaction when
  the stall opened (taken at onset, like `frozenIn`): its handlers, or the
  render they led to, never reached a paint. A later interaction replaces an
  earlier one (pointerdown, then its click); only the matching id ends it.
  Not blamed when a marked task begun after it is still open — the thread is
  inside that entry point (a live-state frame), which merely delayed the paint.
- Its `breakdown` (script / forced style-layout / style-layout / other) and
  `forcedBy` are the slow-interaction split (`stallInteraction` in
  `interaction-judge.ts`) over input → the stall's end, from the frames the
  watchdog holds (`stallFrame` + `during`; LoAF scripts carry `startMs` so
  they clip). A gone / unknown stall has none: all `other`.
- **Fingerprint** `main-thread-stall:interaction:<target key>` — the same
  `interactionTargetKey` as `slow-interaction:` rows, no app, route or
  function: the same control freezing again is one row on any screen.
- **One cause, one report**: the interaction watch records (never reports) an
  interaction a ≥ 5 s long frame overlaps, even when Event Timing measured it
  just under the bar — the stall's report names it.
- The in-tab fallback names the trusted interaction dispatched inside a
  recovered ≥ 5 s frame (`beganIn`).

## Filing goes through a live tab

The worker bundle must be self-contained (no other plugin), so it never POSTs:
it hands each finished stall to a live tab (the stalled tab's own id first —
it came back after a reload — then a visible one), which files it with
`report()` and emits the slow-op on `clientSlowOpSink`
(`debug/slow-ops/core`, with `endedAt` so the span lands where it happened),
then acks. No live tab ⇒ it waits for the next attach.

Its `main-thread` slow-op carries `reportedBy: "main-thread-stall"`: recorded
and drawn, but no second `slow-op` report beside the stall's own.

## Slow interactions: what was clicked, not where

A stall is the thread going silent; a **slow interaction** is the delay a
person felt between a click or key press and the next paint — 300–800 ms is
already a bug, far under any stall bar. The desktop ↔ full-screen switch cost
1–2.5 s (mostly style recalculation forced by layout reads in React's commit)
for weeks, filed only as `slow-op:main-thread:sonata (root)` /
`unattributed`. Design: [`research/2026-11-11-reports-slow-interaction.md`](../../../../research/2026-11-11-reports-slow-interaction.md).

`web/internal/interaction-watch.ts`, installed by the tab watch (no worker:
the tab was never frozen long enough to need one):

- **Measure**: Event Timing entries with an `interactionId`, grouped per
  interaction (the longest stands for it), judged 1 s after they arrive so the
  long frames inside them are in (an id already judged is ignored: a key held
  past the grace). Judged on its **own time** — processing + presentation,
  not input delay: a click that waited on an unrelated long task is that
  frame's slowness, never the clicked control's.
- **Identify at dispatch**: a capture listener on pointerdown / click /
  keydown resolves the target — and reads where the tab is (a click that
  navigates is filed under the screen it was made on) — while it is still in
  the document (a slow switch
  remounts the very button; Event Timing's `target` is then null) — the
  nearest control's ui-context element descriptor, its innermost contribution
  (`plugin@slot`) and pane, its `data-ui-owner` component; a key as its class
  (`char` for a printable key — never what was typed). Attributes and text
  only, never computed style (it runs on the click path). Names: an
  `aria-label`; a button's (switch's, checkbox's) title or text. Tab, menu
  item, link, row and option text is the user's data (a page title, a task in
  a menu) and never part of an identity.
- **Split** (`interaction-judge.ts`, pure and tested): every LoAF script
  clipped to the interaction → `script` / `forced-style-layout` (with
  `forcedBy`, the function that forced the most) / `style-layout` (the
  frame's own pass, less scripts run inside it — ResizeObserver callbacks) /
  `other`; plus Event Timing's input delay / processing / presentation.
- **File**: ≥ 200 ms → an `interaction` slow-op (operation = the target,
  variant = `forced by …` or the top function, waits = the split, caller = the
  route, `reportedBy: "slow-interaction"`); ≥ 800 ms own, or from the 3rd ≥ 300 ms
  of the same target in this page load on → a `slow-interaction` report (each
  occurrence grows its count; the bell re-alerts at most every 30 min),
  fingerprinted by the target alone (never app, route or url). ≥ 5 s (or a
  ≥ 5 s long frame inside it) is the stall's report, which names it; the
  interaction is then only recorded.
- **One cause, one op**: a 1–5 s long frame overlapping a slow interaction is
  the interaction's — `deferSlowFrame` waits the same grace and files the app +
  route `main-thread` slow-op only when no interaction claimed it.

## Storage survives the worker

An open stall is written to IndexedDB (`web/internal/stall-store.ts`) when it
crosses 5 s and at each doubling of its age; a finished one until a tab acks
it. Each record names its owner watchdog, which holds a lifetime Web Lock; a
booting watchdog adopts records whose owner's lock is free (taking that lock
while adopting, so two cannot both adopt one) and files them — `ended:
unknown`, a lower-bound duration, for one that was still open. A filing that
failed stays stored until a later watchdog adopts it.

## The watchdog dies with its host renderer

Chrome runs a SharedWorker inside one tab's renderer (the first tab's). When
that renderer is killed — the usual end of a hung tab — the watchdog dies
too: its stall is filed `unknown` by the next watchdog, and every other tab
re-attaches (each queues for the watchdog's lifetime lock after `hello`;
granted ⇒ it is gone ⇒ attach afresh, which starts and drains a new one).

## Without SharedWorker

`web/internal/in-tab-fallback.ts`: a recovered ≥ 5 s LoAF files directly; a
1 Hz sessionStorage heartbeat (visible only, cleared on pagehide / hide) left
behind by a frozen-then-reloaded tab is filed by its next load (`unknown`,
`detector: in-tab`).

## Verify

`./equin run plugins/reports/plugins/main-thread-stall/e2e/freeze.ts --no-record`
after a build (`--no-record`: the harness screencast hangs on a hung page):
recovered (attributed), gone (second tab killed), unknown (watchdog host
killed). Headless Chromium cannot reload or close a hung tab — it waits on the
renderer forever — so the script kills it with CDP `Page.crash`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Main-thread stall detector: a Core.Root controller that attaches each tab to one out-of-thread SharedWorker watchdog (1 Hz ping, Web Lock per tab, IndexedDB record of an open stall) and feeds it the tab's app, route pattern, visibility and LoAF long frames; a visible tab silent ≥5 s becomes a main-thread-stall report plus a slow-op span (recovered 1–5 s long frames: slow-op only). In-tab fallback without SharedWorker. Slow interactions: Event Timing (input → next paint) per click / key press, its target resolved at dispatch (element, contribution, pane, component), its time split by the long frames inside it; ≥200 ms is an `interaction` slow-op, severe (≥800 ms) or recurring (3× ≥300 ms) a slow-interaction report, and it owns the 1–5 s long frame it caused. Main-thread-stall report kind: validates the stall payload (tab, app, route pattern, duration, how it ended, LoAF attribution, cohort), fingerprints by the interaction's target when a click / key press started the freeze, else by app + route pattern + top attributed function, and renders the investigation task. Slow-interaction report kind: a click / key press whose next paint came late, fingerprinted by what was interacted with (element, contribution, pane, component — never the app or route), its time split into script / forced style-layout / style-layout / other with the function that forced it.
- Web:
  - Contributes:
    - `Core.Root` → `MainThreadStallController`
    - `Reports.KindView` → `MainThreadStallKindView`
    - `Reports.KindView` → `SlowInteractionKindView`
  - Uses:
    - `apps-core.useFocusedAppId`
    - `primitives/css/badge.Badge`
    - `primitives/css/inline.Inline`
    - `primitives/dom/web-storage.defineStore`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/log-channels.clientLog`
    - `primitives/pane.peekRoute`
    - `primitives/pane.usePathname`
    - `primitives/perfs/task-marks.onTaskMark`
    - `primitives/perfs/task-marks.runMarked`
    - `primitives/scope/tab-id.getTabId`
    - `primitives/ui-context.collectLineage`
    - `primitives/ui-context.nearestOwner`
    - `reports.report`
    - `reports.Reports`
- Server:
  - Contributes:
    - `report-kind` "main-thread-stall"
    - `report-kind` "slow-interaction"
  - Uses: `reports.ReportKind`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/font-family --font-mono`
- Core:
  - Exports (types):
    - `InteractionBreakdown`
    - `InteractionTarget`
    - `MainThreadStallPayload`
    - `SlowInteractionPayload`
    - `StallFrame`
    - `StallFrameScript`
    - `StallInteraction`
    - `StallTab`
    - `TaskMark`
  - Exports (values):
    - `dominantLayer`
    - `InteractionBreakdownSchema`
    - `interactionTargetKey`
    - `interactionTargetLabel`
    - `InteractionTargetSchema`
    - `mainThreadStallFingerprint`
    - `MainThreadStallPayloadSchema`
    - `mainThreadStallSummary`
    - `slowInteractionFingerprint`
    - `SlowInteractionPayloadSchema`
    - `slowInteractionSummary`
    - `StallFrameSchema`
    - `StallFrameScriptSchema`
    - `StallInteractionSchema`
    - `StallTabSchema`

<!-- AUTOGENERATED:END -->

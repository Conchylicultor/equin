# Slow interactions: click → next paint, reported per interaction

Supervisor task: task-1794316425-x9f0ro.

## Context

The desktop ↔ full-screen switch blocked the main thread for 1–2.5 s for weeks
(0.9–1.6 s of it style recalculation forced synchronously by layout reads in
React's commit), and nothing named it:

- `reports/main-thread-stall` reports only stalls ≥ 5 s. A recovered long frame
  of 1–5 s becomes a `main-thread` slow-op, which also files a
  `slow-op:main-thread:<app> <route>` report. Anything under 1 s is not
  recorded. A 300–800 ms delay between a click and its paint is already a bug
  the user feels.
- That slow-op is keyed by **app + route pattern**, with the top function only
  as its variant. The switch landed as `sonata (root)`, `unattributed`. Main's
  agent-manager rows (`slow-op:main-thread:agent-manager conversation`, ×33)
  name only `(anonymous) (ResizeObserverCallback)`. You cannot tell *what was
  clicked*, nor that the time went to forced style/layout.

The goal is that a slow user interaction is measured, keyed by **what was
interacted with**, and carries its own breakdown.

## Design

All of this lives in `reports/main-thread-stall`. It already owns the LoAF
observer, and the 1–5 s `main-thread` slow-op is exactly what a slow interaction
must replace, so no second observer and no parallel pipeline are needed. The
plugin gets a second report kind, `slow-interaction`.

### Measuring: Event Timing + the LoAF frames already observed

- `PerformanceObserver({ type: "event", durationThreshold: 200 })`. Only
  entries with `interactionId > 0` count (discrete click / tap / key). The
  entries of one interaction (pointerdown, pointerup, click) are grouped by
  `interactionId`, and the longest one stands for the interaction (the INP rule).
- **Phases** come from that entry: `inputDelay = processingStart − startTime`,
  `processing = processingEnd − processingStart`, and
  `presentation = startTime + duration − processingEnd`.
- **Breakdown** comes from the LoAF frames overlapping `[startTime, startTime +
  duration]`, held in a 10 s ring of raw frames (≥ 50 ms, all LoAF reports).
  Each script is clipped to the window. The partition, which sums to the
  duration:
  - `script`: the scripts' time less their forced style/layout.
  - `forced-style-layout`: `forcedStyleAndLayoutDuration`, the layout reads
    that forced style.
  - `style-layout`: the frame's own style/layout pass,
    `styleAndLayoutStart → end`.
  - `other`: the remainder. This covers paint, compositing, and render steps
    outside scripts.

  The `topFunction` is the script with the most clipped time. The
  `forcedBy` is the script with the most forced style/layout. Both are spelled
  as `function (invoker)`, like a stall's.
- **Grace.** Both entries are delivered after the paint. An interaction is
  judged 1 s after its entry arrives, so its LoAF frames are in (the stall
  machine's `FRAME_GRACE` pattern). This is a one-shot timer, not a poll.

### Identity: what was interacted with

The Event Timing `target` is null once the node is detached, and a slow switch
usually remounts the very button. So the target is resolved **at dispatch**: a
capture-phase listener on `pointerdown`, `click` and `keydown` keeps a ring of
`{ type, timeStamp, identity }`. An entry's `startTime` equals the event's
`timeStamp`. The walk reads only attributes, never computed style (computing it
would itself force style on the click path). It reuses `primitives/ui-context`:

- **element**: the nearest interactive ancestor
  (`button, a, [role=button|menuitem|tab|switch|checkbox|option|treeitem], input,
  select, textarea, [contenteditable], [tabindex]`), described by
  `formatElementDescriptor`. Its name comes from `aria-label`, then `title`,
  then direct text, but direct text is used only for control roles (button,
  tab, menuitem, switch, checkbox). A link or row's text is the user's data
  (a task title), so it is never part of the identity.
- **lineage**: the innermost contribution (`plugin@slot`) and the innermost
  `pane` region, from `collectLineage`, using `lineageNodeIdentity` (no
  positional label). Tab and window regions are left out because their ids
  are per instance.
- **owner**: `data-ui-owner`'s component name, without `@file:line`.
- **key**: for keyboard interactions, a key class (`Enter`, `Escape`, `Tab`,
  arrows, `Mod+<key>` for chords). A printable key alone is `char`, so typed
  text is never recorded.

The **fingerprint** is `slow-interaction:<kind>|<plugin@slot>|<pane>|<owner>|<element>`.
It has no app, route, url or durations: the same control is one row whose count
grows. The app, route pattern and url ride in the payload as context.

### Recording and reporting

| Duration | What happens |
|---|---|
| < 200 ms | nothing |
| ≥ 200 ms | `interaction` slow-op: operation = the identity, variant = `forced by …` or the top function, waits = the breakdown, caller = the route, and `endedAt` places the Timeline span. **No slow-op report** (see `reportedBy` below). |
| ≥ 800 ms, or the 3rd occurrence ≥ 300 ms of the same identity in this page | additionally a `slow-interaction` report (the alert), with the full breakdown and frames |
| ≥ 5 s | slow-op only: the stall detector files the freeze as its own report |

- **One cause, one report.** A 1–5 s long frame overlapping a slow interaction
  (≥ 200 ms) is no longer filed as a `main-thread` app+route slow-op: the
  interaction owns it. The frame decision is deferred by the same 1 s grace.
  Long frames without an interaction (a socket burst, a timer) keep the old
  path.
- **slow-ops gets `reportedBy`** (a report kind name) on
  `ClientSlowOpSignal` → `SlowOpClientItem` → `RecordSlowOpInput`. The item is
  recorded, aggregated and drawn on the Timeline, but `incidentsFor` skips it,
  because the named kind files the alert. Interactions use it. So does the
  ≥ 5 s stall's own `main-thread` slow-op, which today files a duplicate
  `slow-op` report beside the `main-thread-stall` one.
- The `slow-interaction` ReportKind uses `variant: "warning"` and a 30 min
  `notifCooldownMs`. Its `renderTask` explains the phases, the breakdown (with a
  hint per dominant layer, e.g. forced style/layout: "layout read after a DOM
  write, in commit or effects"), the scripts and the identity.
- A `Reports.KindView` summary shows the duration, the target and the dominant
  layer.
- The new source `client-slow-interaction` (a `"page"` origin) is added to
  `reports/core/sources.ts`.

### Pure core, thin shell

- `web/internal/interaction-judge.ts` (pure, tested): it groups entries, picks
  frames, clips scripts, computes the breakdown, `topFunction` and `forcedBy`,
  and decides recurrence (record / report / none) and frame claiming.
- `web/internal/interaction-target.ts`: the DOM identity walk (jsdom-tested).
- `web/internal/interaction-watch.ts`: the observers, the dispatch-time ring,
  the grace timers and the filing. It is installed by `installStallWatch`,
  which gives it every LoAF entry.
- Core: `SlowInteractionPayloadSchema`, the fingerprint and the summary.
  Server: the kind and its task renderer.

## Verification

- Unit tests for the judge (breakdown partition, clipping, grouping, claiming,
  recurrence) and for the target walk (interactive ancestor, name policy,
  lineage).
- `./equin build`. In the agent browser, on this build, add a test button
  whose handler writes and reads layout in a loop (~600 ms forced
  style/layout), click it three times, then one 1 s click. Expect:
  - the `slow_ops` row `interaction …` with `forced-style-layout` as the
    dominant wait;
  - a `slow-interaction` report keyed by the button, with `forcedBy` naming the
    handler;
  - no `slow-op:main-thread:*` report for those frames.
- A review agent on the diff, then `./equin push`.

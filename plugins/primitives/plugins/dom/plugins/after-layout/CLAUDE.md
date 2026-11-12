# after-layout

Read layout where the browser already computed it.

## API

- `afterLayout(read)` → cancel — run `read` once the current frame is styled
  and laid out, before it paints. `read` may set React state and may return a
  **write** (a DOM mutation built from what it read). Every read queued in the
  frame runs in one batch: reads first, then the returned writes, all inside
  one `flushSync`, so their React updates commit before paint.
- `runAsAfterLayout(fn, delivered)` — run a `ResizeObserver` callback as part
  of the phase: reads queued by what it commits run at its end, same frame.
  `delivered` is the callback's entry targets: their shallowest depth bounds
  what the rendering step can still deliver.
- `commitInPhase(update)` — commit React updates (`flushSync`) as part of the
  phase: the one way an observer callback (or a read the phase drains) commits
  before paint. Whatever that commit resizes at or above the delivery is
  answered in the same phase (see *Commits inside a delivery*).
- `observeInPhase(observer, el, onHeldBack?)` → release — start an observation
  where the browser can deliver it, and keep it in the set the phase settles
  (release it instead of `unobserve`). Outside a phase it observes now and arms
  the root trigger, so the first notification shares the root's broadcast
  (whose shallowest depth is the root's: its callback may commit layout at any
  depth). Inside a phase, a target deeper than the delivery observes now; one
  at or above it — which the browser would hold back with a "loop completed"
  error — observes at the next frame's animation-frame callbacks, before that
  frame gathers its observations. `onHeldBack` is the observer's response to a
  resize, run in the phase when one of its commits resizes `el` where the
  browser can no longer deliver it.
- Under jsdom (its user agent says so) reads run at once, where they are
  queued: there is no layout to wait for, and nothing a read could force.

## Why

A layout or style read (`getBoundingClientRect`, `getComputedStyle`,
`offsetWidth`, `checkVisibility`…) on React's commit path — a layout effect, a
ref callback — forces the browser to recompute style and layout for the whole
dirty document right there; a write between two reads makes the next one pay
again. Right after a large style change (the desktop's full-screen switch), the
first reader paid hundreds of ms. After layout, the read costs nothing.

## How

The phase is a `ResizeObserver` delivery — the rendering step's one callback
point between layout and paint — armed by observing the root element afresh
(a new observation of a box with a size is delivered at the next rendering
step). Readers mounted by the phase's own commit, or by a commit inside
another observer's callback (element-size wraps its callbacks in
`runAsAfterLayout`), are drained in the same frame instead of arming a new
observation mid-delivery, which the browser would defer with a "loop
completed" error. A read that keeps re-queueing itself throws after 50 passes.
A read that throws does not cost the rest of the batch its turn: every read
runs, then the failures are rethrown (one error, or an `AggregateError`).

## Commits inside a delivery

The browser delivers resizes in broadcasts of increasing depth: after a
broadcast, it delivers in the same step only elements DEEPER than that
broadcast's shallowest target. A commit made inside a deep callback (a column
fit, a first measure mounted by another measure's commit) can resize anything —
the chrome above the measured box, a fixed band, the box itself; the browser
would hold those resizes back a frame (painting the old size meanwhile) and
report "ResizeObserver loop completed with undelivered notifications".

So the phase settles them itself. `commitInPhase` records, before the phase's
first commit, the box of every observation at or above the delivery
(`getBoundingClientRect` size and client size — the same read before and after,
and no transform advances inside one task). When the phase ends, each one the
commits resized is stopped (nothing left for the browser to hold back),
restarted at the next frame, and answered now through its `onHeldBack` — which
may commit and resize more, settled the same way (at most 50 passes, then it
throws). A phase that commits nothing reads nothing; the root's phase reaches
every depth and records nothing.

Not covered: a change of the content box alone (padding, with the border box
and client box unchanged) — the browser still reports that one, and the
resize-loop tracer (`element-size/resize-loop-trace`) names it.

## Caveats

- **Reads wait for a rendered frame.** In a hidden tab the rendering step does
  not run, so a read queued there runs when the page is shown again (the
  synchronous read it replaces would have measured a page nobody sees).
- **A library's own `ResizeObserver` commits with a raw `flushSync`.** Base
  UI positions every popup with floating-ui, whose `autoUpdate` observes the
  trigger and floating element itself and commits from a microtask of its
  callback (`computePosition(...).then(() => flushSync(...))`); the lint
  (`no-raw-resize-observer`) cannot see `node_modules`. The phase therefore
  watches every delivery on the page, not only its own: this module replaces
  the page's `ResizeObserver` when it evaluates (`installDeliveryWatch`, no
  install step to forget), so each callback — whoever created the observer —
  marks a delivery with its targets until the rendering step ends (the next
  task, or the next frame's first animation callback). Inside one, the root
  trigger is never armed (queued reads run as a phase of that delivery, in a
  microtask) and `observeInPhase` starts a target the delivery can no longer
  reach at the next frame. What a library's own commit RESIZES above its
  delivery is still the browser's to report (it never goes through
  `commitInPhase`); the resize-loop tracer names the observer and the element.

Who reads through it: `dom/element-size` (initial measure, target resolution)
and `dom/layout-host` (`useHostFlowAxis`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Read layout where the browser already computed it: afterLayout(read) runs `read` once the current frame is styled and laid out, before it paints (a ResizeObserver delivery), batched with every other read of that frame — reads first, then the writes they return, then one React commit (flushSync) — so a layout or style read never forces a synchronous recalc on React's commit path, and a write never sits between two reads. runAsAfterLayout(fn, delivered) lets a ResizeObserver callback join the phase; commitInPhase(update) is its one way to commit before paint — whatever that commit resizes at or above the delivery (which the browser could only deliver a frame late, with a 'ResizeObserver loop' error) is answered in the same phase through the observer's onHeldBack, and its observation restarted at the next frame; observeInPhase(observer, el, onHeldBack?) starts and keeps an observation where the browser can deliver it — at once, or (a target the running delivery can no longer reach) at the next frame — and arms the root trigger with one started outside a phase, so its first callback shares the root's broadcast. element-size and layout-host read through it.
- Cross-plugin:
  - Imported by:
    - `primitives/css/layout-harness`
    - `primitives/dom/element-size`
    - `primitives/dom/layout-host`
- Exemptions:
  - Exempts itself from: `resize-observer-safety/no-raw-resize-observer` — `web/internal/after-layout.ts` (sanctioned)
- Web:
  - Exports (types): `AfterLayoutRead`
  - Exports (values):
    - `afterLayout`
    - `commitInPhase`
    - `observeInPhase`
    - `runAsAfterLayout`

<!-- AUTOGENERATED:END -->

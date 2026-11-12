# element-size

The single sanctioned home for the "measure an element via `ResizeObserver`"
idiom, hand-rolled inconsistently across the repo before this primitive.

## API

- `useElementSize<T>(target?)` → `[callbackRef, { width, height }]`
  Reactive LAYOUT size: the border box in the element's own CSS pixels
  (fractional), read from the `ResizeObserver`'s own entries. Attach the
  returned callback ref to the node; `{0,0}` until first measure. Never the
  visual size (`getBoundingClientRect`): the observer does not fire when a
  transform changes, so a visual read taken under one (a desktop window's open
  tween scales it by 0.96) stayed wrong until an unrelated resize — and its
  correction restyled everything the published value reaches (a DataView's
  `--dv-header-offset`: ~20k elements on the first full-screen switch).
  Pass a `target` getter to measure a different node than the one the ref is
  on (e.g. `(el) => el.offsetParent`); it may read layout, so it is resolved in
  the after-layout phase — its first delivery then comes in a later broadcast
  of the same step (see below: what its commit resizes above it is settled).

- `useResizeObserver(target, onResize, { debounce?, deps?, beforePaint? })` → `void`
  The substrate. `target` is a `RefObject`, an array of refs, or a getter
  (`() => Element | Element[] | null`). Runs `onResize` once on mount (and
  when `deps` change) after layout, before paint, then on every resize — RAF-debounced unless
  `debounce: false`. `onResize` is stabilised internally, so the observer never
  re-subscribes on closure churn; use `deps` to force a re-measure.
  `beforePaint: true` is for a size that decides layout (the data table's
  column fit): each resize runs `onResize` in the observer callback and
  commits its updates there (after-layout's `commitInPhase`), so no frame
  paints the old layout at the new size — the RAF + scheduled render of the
  default path paints one or two. The layout it changes may be anywhere (see
  below).

- `useResizeObserverSet(onResize)` → `observe(el) => release`
  One observer over a CHANGING set of elements (the rows a windowed list mounts
  and unmounts): `observe` is stable, returns the element's release (use it as a
  React 19 ref-callback cleanup), measures the new element after layout, then
  hands `onResize` every element whose size changed, RAF-batched. The list
  view's aligned trailing slots are the consumer.

## The initial measure runs after layout, before paint

`useElementSize`'s first measure is the observer's first delivery, committed
in the same phase. The node (with no `target` getter) is observed on the commit path, through
`observeInPhase`, which arms the after-layout root trigger with it: the first
notification is delivered in the next rendering step's FIRST broadcast,
together with the root's, so that broadcast's shallowest depth is the root's
and the commit made there may change layout at any depth.

`useResizeObserver`'s first `onResize` (and its `target`
getter) runs in the frame's
after-layout phase ([`dom/after-layout`](../after-layout/CLAUDE.md)) — not in
the layout effect, and not behind RAF. Behind RAF would paint a frame first (a
flash); in the layout effect, every read forces the browser to recompute style
and layout for the whole dirty document on React's commit path, and again for
the next reader after any write — a slot or chrome mounting right after a large
style change (the desktop's full-screen switch) paid hundreds of ms there.
After layout, the browser has already computed what the read wants; the
batch's React updates commit in one `flushSync`, before paint.

`onResize` may return a write (a DOM mutation built from its read): it runs
after every read of the batch (the floating bar's safe-area var on `:root`
would otherwise invalidate every later reader's style).

## No observation is ever held back: `observeInPhase`

Every observation the primitive starts goes through after-layout's
`observeInPhase`. The browser delivers resize notifications in broadcasts of
increasing depth: once a broadcast ran, a notification for an element at or
above its shallowest target waits for the next frame, and the step ends with
"ResizeObserver loop completed with undelivered notifications". A phase drained
inside a deep observer's callback (a canvas measuring its room, a column fit)
commits components that start observations of their own — some of them
shallow (an overflow panel portaled to the body, a fixed band). Started there,
the browser would hold them back; `observeInPhase` starts such an observation
at the next frame instead (an animation-frame callback, before that frame's
observers are gathered) — the same frame the browser would have delivered it
in, with no loop. The first measure never waits for it: it is taken directly
(`useResizeObserver`'s `onResize`, `useResizeObserverSet`'s first call).

A commit made inside a deep callback can also RESIZE an element at or above
the broadcast (a `beforePaint` handler changing the chrome around the box, a
`useElementSize` mounted by such a commit, or one with a `target` getter whose
first delivery changes what is above it). Every commit the primitive makes goes
through after-layout's `commitInPhase`, which settles that in the same phase:
each observation it resized there is answered now — `useResizeObserver` runs
its `onResize` (a `beforePaint` one commits before paint, as an in-time
delivery would), `useResizeObserverSet` queues the element — and restarted at
the next frame, so nothing is left for the browser to hold back.
`useElementSize`'s size is the browser's own entry, so its answer comes with
the restarted observation, at the next frame — when its RAF-debounced measures
commit anyway. See [`dom/after-layout`](../after-layout/CLAUDE.md) § Commits
inside a delivery.

Under jsdom the phase runs at once, so the initial measure is
still the synchronous one a test asserts after render — enough to decide layout
under the shared **inert** observer (jsdom has no `ResizeObserver` and no layout
engine, so a polyfill would have nothing to report). A test needing a real size
stubs the measurement source itself (e.g. `expandable`'s `offsetHeight`
fixture), and a test needing to drive resizes installs a drivable observer via
`vi.stubGlobal`.

## Don't hand-roll `new ResizeObserver`

Enforced by the `resize-observer-safety` lint rule
([`no-raw-resize-observer`](../../../../../framework/plugins/tooling/plugins/lint/plugins/resize-observer-safety/lint/no-raw-resize-observer.ts)).
Route size/resize observation through this primitive; if you have a genuinely
different need, extend the primitive rather than allowlisting a copy.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Element-size ResizeObserver idiom as a primitive: useElementSize() reactively measures an element's layout size (callback ref; the observer's own border-box size, so a transform never freezes a wrong value; its first delivery shares the after-layout root's broadcast, so the commit it makes may change layout at any depth), useResizeObserver(target, onResize, {debounce, deps}) is the substrate, and useResizeObserverSet(onResize) observes a changing set of elements (windowed rows) through one observer — initial measure after layout and before paint (dom/after-layout: no forced recalc on the commit path), RAF-debounced resize callbacks, every observation started through after-layout's observeInPhase and every commit made through its commitInPhase (an observation is never held back into a 'ResizeObserver loop', and what a commit inside a delivery resizes above it is answered in the same phase), auto cleanup. The single sanctioned home for the hand-rolled ResizeObserver-for-size idiom.
- Web:
  - Uses:
    - `primitives/dom/after-layout.afterLayout`
    - `primitives/dom/after-layout.AfterLayoutRead`
    - `primitives/dom/after-layout.commitInPhase`
    - `primitives/dom/after-layout.observeInPhase`
    - `primitives/dom/after-layout.runAsAfterLayout`
    - `primitives/latest-ref.useEventCallback`
  - Exports (types):
    - `ElementSize`
    - `ResizeTarget`
  - Exports (values):
    - `useElementSize`
    - `useResizeObserver`
    - `useResizeObserverSet`
- Cross-plugin:
  - Imported by: 48 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives` ×25
    - `apps` ×13
    - `shell` ×2
    - `active-data/go`
    - `conversations/conversation-view/jsonl-viewer`
    - `hints`
    - `layouts/miller`
    - `menu-bar`
    - `page/editor`
    - `screenshot`
    - `ui/ambient-field`
- Exemptions:
  - Exempts itself from: `resize-observer-safety/no-raw-resize-observer` — `web/internal/element-size.ts` (sanctioned)
- Sub-plugins:
  - **`resize-loop-trace`** — Names the observers behind a 'ResizeObserver loop completed with undelivered notifications' error, which the browser raises with no stack: installResizeLoopTrace() (imported first by main.tsx) wraps…

<!-- AUTOGENERATED:END -->

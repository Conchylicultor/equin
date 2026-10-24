# Render-loop / DOM-rebuild-thrash runtime detection

## Context

Pathological client-side render loops and continuous DOM-rebuild thrash currently
go **completely undetected**. A real instance — a code block's `<pre>` being torn
down and rebuilt ~4×/second while the conversation was idle, plus the whole
transcript markdown re-rendering on a ~1s cascade with ~300 DOM attribute
writes/second — was only discovered by hand via per-frame `MutationObserver`
instrumentation. Nothing surfaced it: it isn't a React "maximum update depth"
loop, so there's no console error, no crash, and no signal in the reports system.

These loops are silent battery/CPU drains. We want **runtime detection** in the
browser that recognizes when an element/subtree is being rebuilt or re-mutated at
a sustained high rate with **no user interaction** and **no meaningful content
change** (wasted work), and files a **deduped report** through the existing
reports/crash pipeline — the same one that records browser crashes and files
tasks — so these get auto-detected instead of relying on a human noticing jank.

**Scope:** detection is `MutationObserver`-based, i.e. it catches **actual DOM
thrash** (the thing that burns CPU/battery). React re-renders that diff to *no*
DOM output are out of scope (no DOM cost, and detecting them needs invasive React
profiler hooks). This matches the reported instance exactly.

**Decisions (confirmed with user):**
- Rollout: **file the report immediately AND mirror every firing + near-miss to a
  `render-loop` clientLog channel** for inspection/threshold tuning.
- Severity: **`variant: "warning"` with `notifCooldownMs` (re-arm periodically,
  e.g. 6h)** — a perf smell, not a crash; a still-present loop resurfaces
  occasionally rather than once-forever.

## Approach

A new sub-plugin under the reports umbrella, `plugins/reports/plugins/render-loop/`,
mirroring the existing `crash` kind's three-runtime shape (core / server / web).
A single headless `Core.Root` controller installs one global `MutationObserver`;
when its gated heuristic fires, it calls the generic `report()` entry point with a
new `"render-loop"` kind. The server registers a `ReportKind` that validates,
fingerprints (for dedup), and renders the filed task.

### The detector (event-driven, no polling)

One global `MutationObserver` on `document.body`:
`{ subtree: true, childList: true, attributes: true, attributeOldValue: true }`.
The pathological element fires continuous mutations — those callbacks **are** the
push signal (no `setInterval`; satisfies the no-polling rule). In the callback we
attribute each `MutationRecord` to a stable **culprit signature** and keep
per-signature sliding-window counters.

**Fire a report when ALL gates hold:**
1. **Sustained** — one signature stays above its class threshold continuously for
   `SUSTAINED_MS` (≥3s). Thresholds split by class: `REBUILD_PER_SEC = 3` for
   childList identical-rebuilds, `NOOP_ATTR_PER_SEC = 30` for no-op/oscillating
   attribute writes.
2. **Idle** — no `pointerdown/pointermove/keydown/wheel/scroll/input` within
   `IDLE_MS` (≈2s). Tracked via global listeners updating `lastInteractionAt`.
3. **Visible** — `document.visibilityState === "visible"` (early-return guard).
4. **Wasted-work** (the key false-positive discriminator) — either:
   - **(4a) no-op / oscillating attribute writes**: `record.target`'s current
     attr value equals `record.oldValue` (pure no-op), OR the value **oscillates**
     — a small ring of recent values per `(signature, attr)` shows ≤
     `MAX_DISTINCT_VALUES` (≈4) distinct values with at least one revisited ≥
     `MIN_VALUE_REPEAT` (3). (Excludes monotonic progress bars / timers, which
     never revisit a value.) Exclude animation-class attrs
     (`transform`/`willChange`/`transition` on `style`).
   - **(4b) childList identical rebuild**: the same parent repeatedly has both
     `addedNodes` and `removedNodes` whose **(tagName + stable markers)** multisets
     match — i.e. the same source lines torn down and rebuilt (the real `<pre>`
     case). Comparing markers (`data-source`/`data-plugin-id`/`data-contribution-id`),
     not just tagName, distinguishes a real rebuild from a list swapping one
     `<li>` for a *different* `<li>`.

After firing once per signature per session, add its fingerprint to a `Set` and
never re-evaluate it (debounce). GC per-signature counters idle > `GC_IDLE_MS`.

This combination cleanly excludes every legitimate high-frequency scenario:
streaming text (additive append, not add+remove of identical structure → fails
4b), typing/drag/resize (fails idle gate 2), CSS spinners/animations (no DOM
mutations at all), virtualized scroll (different content + interaction), progress
bars/timers (monotonic → fails oscillation in 4a), live-state bursts (not
sustained 3s).

### Culprit signature (stable across rebuilds, specific enough to localize)

The DOM already carries stable build/composition markers (emitted by the
element-picker's middleware + Babel plugin), which survive teardown→rebuild
because they're keyed by plugin/slot/source identity, not React instance:
- `data-plugin-id` / `data-slot-id` / `data-contribution-id` on the
  `display:contents` marker span wrapping every slot contribution.
- `data-source="file:line"` and `data-ui-owner="Name@file:line"` on host elements
  (present when the element-picker plugin is in the composition — treat as
  best-effort).
- `data-pane-id` (stable pane-type id, safe to include).

**Algorithm** (`culpritSignature(node)`): resolve text→parent element, skip
`display:contents` marker spans, then compose:
`pluginId@slotId | data-source | data-ui-owner | pane:<id> | boundedPath`, where
`boundedPath` walks from the node up to the nearest stable-marker anchor using
`tagName:nth-of-type(k)` (NOT `nth-child`), capped at `PATH_MAX_DEPTH` (4) — so two
code blocks sharing one source line still separate. Truncate to `SIGNATURE_CAP`.

Reuse the `closest()`-based marker walk from
`plugins/improve/plugins/element-picker/web/internal/marker-lineage.ts` /
`collect-meta.ts` (the `isMarkerSpan` skip + bounded-selector logic). **Do not
cross-plugin-import private internals** — re-implement the ~30-line walk locally in
the detector (small, and the export may not be public; respects boundary rules).

`fingerprint(data) = sha256Hex(signature + "|" + mutationClass + "|" + (attrName ?? "")).slice(0,16)`
— rate/timing **excluded** so all repeats dedup to one row/task (same pattern as
`crashFingerprint`).

### Self-exclusion

Early-skip mutations whose target is inside benign DOM-emitting chrome (via
`closest()`): the toaster (`[data-sonner-toaster]` / `[data-sonner-toast]`),
overscroll-hint's per-rAF `transform`/`willChange` writes (also covered by the
animation-attr exclusion in 4a), the element-picker overlay, and marker spans
themselves. The detector writes no DOM of its own (report = network POST).

## Files

New sub-plugin `plugins/reports/plugins/render-loop/` (mirror
`plugins/reports/plugins/crash/`):

- **`core/render-loop-kind.ts`** — `RenderLoopPayloadSchema` (zod),
  `renderLoopFingerprint(data)`, and the shared `RENDER_LOOP` constants object
  (window/thresholds/idle/oscillation/path caps). Mirror
  `plugins/reports/plugins/crash/core/crash-kind.ts`.
- **`core/index.ts`** — barrel exporting the schema, fingerprint, constants.
- **`server/index.ts`** — `ReportKind({ kind: "render-loop", schema, fingerprint,
  meta: { tag: "[render-loop]", notif: "Render loop detected", variant: "warning",
  notifCooldownMs: 6h }, renderTask })`. Mirror
  `plugins/reports/plugins/crash/server/index.ts`.
- **`server/internal/render-render-loop-task.ts`** — `renderTask({title,
  description})` describing the culprit (plugin/slot, source line, selector,
  mutation class, sample values, rate, how it was detected, how to fix). Mirror
  `plugins/reports/plugins/crash/server/internal/render-crash-task.ts`.
- **`web/index.ts`** — `Core.Root({ component: RenderLoopController })`.
- **`web/internal/render-loop-controller.tsx`** — renders `null`,
  `useEffect(() => installRenderLoopDetector(), [])`. Mirror
  `plugins/primitives/plugins/overscroll-hint/web/internal/overscroll-hint-controller.tsx`.
- **`web/internal/render-loop-detector.ts`** — framework-free
  `installRenderLoopDetector(): () => void`: installs the MutationObserver +
  interaction listeners, runs the gated heuristic, calls `report(...)` from
  `@plugins/reports/web` on fire, mirrors firings + near-misses via
  `clientLog("render-loop", ...)` from
  `@plugins/primitives/plugins/log-channels/web`, and returns a cleanup that
  disconnects the observer and removes listeners. Mirror the install/cleanup +
  constants-at-top shape of
  `plugins/primitives/plugins/overscroll-hint/web/internal/overscroll-detector.ts`.
- **`web/internal/culprit-signature.ts`** — the local marker-walk + bounded-path
  signature builder.

Edit (one generic, additive change):

- **`plugins/reports/shared/types.ts`** — add `"client-render-loop"` to
  `CLIENT_REPORT_SOURCES`. The detector reports with `source: "client-render-loop"`.

No registry edits — `./equin build` auto-discovers the new plugin barrels.

### `data` payload (validated server-side)

`{ signature, pluginId?, slotId?, contributionId?, source?, owner?, paneId?,
selector?, mutationClass: "noop-attr"|"oscillating-attr"|"childlist-rebuild",
attrName?, ratePerSec, sustainedMs, sampleValues?[], tagMultiset?,
visibilityState, msSinceInteraction }`.

## Verification

1. `./equin build` from the worktree; confirm it boots and registers the
   new plugin (no boundary/registry/check failures). Run
   `./equin check plugin-boundaries` and `./equin check type-check`.
2. **Synthetic loop (positive case):** open the app, then in the browser console
   create an idle DOM-rebuild loop, e.g. a `requestAnimationFrame` loop that, on a
   real app element, repeatedly removes and re-appends an identical child (or
   re-writes an attribute to the same value) ~4×/s for >3s without touching the
   mouse/keyboard. Confirm: (a) a `[render-loop]` task appears under the Reports
   meta-container (Debug → Reports), (b) repeating the loop bumps `count` rather
   than creating a new row (dedup), (c) the `render-loop` clientLog channel
   (`~/.singularity/worktrees/<wt>/logs/render-loop.jsonl`) records the firing with
   signature/class/rate.
3. **Negative cases (no report):** verify no task is filed while (a) actively
   typing/scrolling, (b) an assistant message streams in, (c) a determinate
   progress/timer advances monotonically, (d) the tab is backgrounded. Confirm
   near-misses (passed idle+sustained but failed wasted-work) land only in the log
   channel, not as tasks.
4. Inspect `query_db` against `reports` to confirm the row's `kind="render-loop"`,
   `fingerprint`, `data` payload, and `task_id` link.
5. Leave it running against normal usage for a session and review the
   `render-loop` log channel for false positives before trusting the auto-filed
   tasks; tune the `RENDER_LOOP` constants if needed.

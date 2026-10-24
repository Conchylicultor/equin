# Sonata notation lens — virtualize systems + cross-system ties

## Context

The Sonata **notation** (sheet-music) Display lens engraves the whole score into
**one SVG in one synchronous call** on mount/score/width change
(`plugins/apps/plugins/sonata/plugins/notation/web/components/engrave.ts`,
`engrave()`), then follows playback with an imperative (zero-render) playhead.
Two documented caveats motivate this work (see `notation/CLAUDE.md`):

- **Eager rendering** — all systems engrave at once. On a long score (e.g. the
  seeded *Für Elise*, 3/8 → many short bars → many systems) switching to the
  notation lens does O(all-systems) VexFlow SVG DOM creation synchronously.
- **Cross-system ties are dropped** — a tie whose two notes land in different
  systems isn't drawn (`engrave.ts` builds a fresh per-system `seqs` map and
  calls `drawTies` inside the per-system loop, so a boundary tie is lost).

### Perf finding — important scoping correction

The originating symptom was a *"page-load took ~3.1s"* slow-op toast on the song
page. Investigation shows this is **NOT** caused by the notation engrave:

- The `Sonata.Display` slot is a **dispatch** slot
  (`shell/web/slots.ts`, `key: (props) => props.activeDisplayId`); it mounts
  **only the active lens**. **piano-roll is the default**
  (`piano-roll/web/index.ts`, `default: true`) — so on a normal load the
  `Notation` component and its `engrave()` **never run**
  (`slot-render/web/internal/render-slot.tsx` instantiates only the matched
  component).
- The `page-load` slow-op is recorded once per hard navigation by
  `SlowOpCollector` at `Core.Root`
  (`debug/plugins/slow-ops/web/components/slow-op-collector.tsx`), and the app
  gates first paint on `loadPlugins()` awaiting **every** plugin's dynamic
  import across the whole platform (`web-sdk/core/loader.ts`,
  `web-core/web/App.tsx`). So ~3.1s is a **whole-app cold-boot** cost (eager JS
  bytes), not Sonata-specific; the `/sonata/song/:id` path is just where the
  reload happened.

**Conclusion:** virtualizing notation does not move the reported 3.1s. It *does*
remove real, O(systems) jank **when a user opens/switches to the notation lens on
a long score** — the case the task and `CLAUDE.md` caveat actually target. The
cross-system tie fix is requested unconditionally. The whole-app boot cost is a
separate, larger concern → filed as a follow-up (bundle analysis via
`debug/boot-profile` + `VITE_ANALYZE=1`), out of scope here.

## Goals

1. **Virtualize off-screen systems**: only engrave/draw systems near the
   viewport; off-screen systems create no SVG DOM. Reuse the existing
   `@plugins/primitives/plugins/virtual-rows/web` windowing primitive.
2. **Draw cross-system ties** as VexFlow **partial/hanging ties** — a stub off
   the right edge of the ending system's last note + a matching stub in from the
   left edge of the next system's first note. Virtualization-safe: each stub is
   local to its own system (the two systems need not be mounted together).

Both are enabled by the same refactor: split the monolithic `engrave()` into a
cheap **layout/plan** pass (all systems) and a **per-system draw** pass (only
mounted systems, each into its own `<svg>`).

## Design

### Why per-system `<svg>` (not one shared `<svg>`)

`virtual-rows` requires each row to be its own DOM node it can absolutely
position; an SVG `<g>` cannot be a `<div>` child nor CSS-transformed. So each
system must be a standalone `<svg>` in its own row div. Confirmed constraint.

### Split `engrave.ts` into two phases

**`planEngraving(model, width, endBeat) → EngravePlan`** (pure geometry + VexFlow
*measurement* only, no draw):
- Runs the existing **Pass 1** (build each measure's voices, `Formatter.
  preCalculateMinTotalWidth` → `minWidth`) and **Pass 2** (greedy line-break into
  systems). The built VexFlow voices are used only to measure width, then
  discarded (VexFlow voices are single-use — formatting mutates them).
- Computes per-system geometry from existing constants (`systemPitch`,
  `contentHeight`, `SYSTEM_TOP_PAD`, `SYSTEM_BOTTOM_PAD`, `SYSTEM_GAP`,
  `TOP_PAD`). Systems are **uniform height** today, so `estimateSize =
  systemPitch` is exact.
- Returns:
  ```ts
  interface SystemPlan {
    index: number;
    measures: EngMeasure[];        // pure slices; draw rebuilds voices
    scoreStart: boolean;           // system 0 → time-sig + part labels
    scale: number; extra0: number; // width distribution (was per-system in Pass 3)
    startBeat: number; endBeat: number; // for beat→system lookup (no draw needed)
    tieIn: Set<string>;            // voiceKey "si:vi" receiving an incoming tie
    tieOut: Set<string>;           // voiceKey "si:vi" sending a hanging tie
  }
  interface EngravePlan {
    systems: SystemPlan[];
    parts: EngPart[];
    systemSvgHeight: number;       // SYSTEM_TOP_PAD + contentHeight + SYSTEM_BOTTOM_PAD
    rowHeight: number;             // systemPitch (svg height + SYSTEM_GAP)
    firstStaffTopInSystem: number; // SYSTEM_TOP_PAD (0-based within a system svg)
    contentHeight: number;
    staffOffsets: number[];
    hasLabels: boolean; leftPad: number;
    endBeat: number;
  }
  ```

- **Cross-system tie sets** (`tieIn`/`tieOut`): computed from the **pure model**,
  mirroring the existing within-system tie assumption exactly (voiceKey =
  `staffIndex:voiceIndex`, sequence appended across measures, skip if either side
  `isRest`). For each voiceKey, walk measures in order building the flat
  tickable list and note which system each tickable falls in. At a system
  boundary K→K+1: if the last tickable of the key in system K is non-rest with
  `tieToNext === true` and the first tickable of the same key in system K+1 is
  non-rest, add `key` to `systems[K].tieOut` and `systems[K+1].tieIn`.

**`drawSystem(host, plan, systemIndex, colors) → { anchors, notes }`**:
- Builds **fresh** VexFlow voices for that system's measures (the moved Pass-3
  body), draws into one `Renderer(host, SVG)` sized `[width, systemSvgHeight]`,
  y-offsets **rebased to 0** within the system (first staff at
  `firstStaffTopInSystem`).
- Connectors/braces/brackets, chord symbols, tuplets, beams, graces are all
  already per-measure/per-system → move verbatim.
- **Part labels**: currently only on system 0. Keep on the score-start system.
- **In-system ties**: unchanged (`drawTies` over the per-voice seq).
- **Cross-system stubs**: after in-system ties, for each voiceKey in
  `plan.systems[systemIndex].tieOut`, draw a hanging tie
  `new StaveTie({ first_note: lastNoteOfKey, last_note: null })`; for each in
  `tieIn`, `new StaveTie({ first_note: null, last_note: firstNoteOfKey })`.
  (VexFlow 4.x supports partial ties by omitting one endpoint — **verify the
  exact option shape against installed `vexflow` types during implementation**;
  `bun install` runs in `./equin build`.)
- `anchors`/`notes` x-values are **within the system svg** (== the row's left
  edge), which is what the playhead needs. `anchors` no longer need a global
  `systemIndex`-keyed x; they're keyed by the registry (below).

### `notation.tsx` rewrite — virtualized body + preserved imperative playhead

- Compute `plan = useMemo(() => planEngraving(model, size.width, endBeat), …)`.
- **Windowing**: use the **headless `useVirtualRows`** hook (not `<VirtualRows>`)
  so the sizer can host the playhead overlay as a sibling.
  `items = plan.systems`, `estimateSize = plan.rowHeight`, `getKey = idx`.
  The sizer div is `relative` height `totalSize`; each windowed row is an
  absolutely-positioned `translateY(vi.start - scrollMargin)` div hosting a
  `<NotationSystem>`.
- **`<NotationSystem>`** (new `web/components/notation-system.tsx`): on mount,
  `drawSystem(hostRef, plan, index, colors)` into its own host div and
  **registers** its `{ anchors, notes }` into a shared
  `Map<number, SystemDrawResult>` ref (keyed by system index); unregisters on
  unmount. Drawing in `useLayoutEffect` (paint-before-show, no flash), same as
  today. Click-to-seek stays via one delegated `onClick` on the sizer reading
  `.vf-note` `dataset.beat` (unchanged handler).
- **`applyCursor(beat)`** (imperative, zero-render, unchanged shape):
  1. beat → `systemIndex` via `plan.systems` `startBeat/endBeat` (binary search;
     no draw needed).
  2. `systemTop = systemIndex * plan.rowHeight` (uniform); playhead y =
     `systemTop + plan.firstStaffTopInSystem - SYSTEM_TOP_PAD`... height =
     system box height. (Rebase the today math into sizer coordinates.)
  3. x within the active system from the **registry** entry's `anchors`
     (interpolate between the two bracketing anchors, same `locate()` logic).
     The active system is always mounted because auto-scroll centers it; if the
     registry lookup misses (mid-scroll, off-window), hide the playhead for that
     frame (loud-safe — reappears next frame once mounted).
  4. Highlight: iterate the union of registered systems' `notes` (only mounted
     systems have notes; the sounding note is in the active, mounted system).
- **Auto-scroll**: on system-boundary change while playing, call
  `virtualizer.scrollToIndex(systemIndex, { align: "center" })` (replaces the
  manual `scrollTo`). Keeps the active system mounted → anchors available.
- **Terminal anchor** (score end): keep an end anchor on the last system so the
  playhead travels to the finish; store it on the plan / last registry entry.

### Coordinate summary

```
row height (estimateSize)          = plan.rowHeight = systemPitch
per-system svg height              = SYSTEM_TOP_PAD + contentHeight + SYSTEM_BOTTOM_PAD
first staff top within system svg  = SYSTEM_TOP_PAD (0-based)
system top in sizer space          = index * rowHeight
playhead x                         = registry[activeIdx].anchors (interpolated)
```

## Files

- `notation/web/components/engrave.ts` — split into `planEngraving()` +
  `drawSystem()`; add `tieIn/tieOut` computation; add partial-tie draws; rebase
  y to 0; per-system `Renderer`. Export `EngravePlan`, `SystemPlan`,
  `SystemDrawResult`.
- `notation/web/components/notation.tsx` — replace the single-host layout effect
  with the `useVirtualRows` sizer + `<NotationSystem>` rows + playhead overlay;
  rewrite `applyCursor` to registry + plan geometry; auto-scroll via
  `virtualizer.scrollToIndex`.
- `notation/web/components/notation-system.tsx` — **new** per-system component
  (draw on mount, register/unregister anchors+notes).
- `notation/package.json` — add `@plugins/primitives/plugins/virtual-rows` (via
  workspace) if not resolvable; it's a plugin barrel import, so just import from
  `@plugins/primitives/plugins/virtual-rows/web`.
- `notation/CLAUDE.md` — update the two resolved caveats (eager render →
  virtualized; cross-system ties → drawn as hanging ties).

Reuse: `useVirtualRows` (`primitives/virtual-rows/web`), existing engrave layout
constants/helpers (`staffOffsets`, `drawConnectors`, `buildVoice`, `tagVoice`,
`drawTies`, `buildTuplets`), `useElementSize`, `useLatestRef`, `Scroll`, `Inset`.

## Edge cases

- **Empty score / no notes** → same placeholder as today.
- **width = 0** (pre-measure) → skip planning; render nothing until measured.
- **Single system** → one row; virtualization is a no-op; hanging ties never fire
  (no boundary).
- **Resize / config / hidden-track / score change** → `plan` recomputes
  (memo deps), registry is cleared, rows re-mount and redraw. Playhead re-locates
  next frame.
- **Score change during playback** → auto-scroll re-centers on the new active
  system after re-plan.
- **Voice-index instability across a boundary** → mirror existing behavior (only
  connect same voiceKey); no regression vs. today's within-system ties.

## Verification

1. `./equin build` (from the worktree dir). App at
   `http://att-1782945768-hlnu.localhost:9000`.
2. Playwright (`e2e/screenshot.mjs`): open the seeded *Für Elise*, switch the
   Display picker to **Notation**.
   - Confirm only a windowed subset of `<svg>` systems is in the DOM (count
     `.notation-surface svg` ≪ total systems), and it grows as you scroll.
   - Press Play: confirm the playhead tracks within a system, auto-scrolls on
     system boundaries, and the active note highlights.
   - Confirm a tie spanning a system break renders as a hanging tie on both
     sides (Für Elise's long LH pedal tones / the rhythm-étude fixture).
3. Unit tests stay green: `bun test plugins/apps/plugins/sonata/plugins/notation`
   (convert/rhythm/grace/voices/durations are unaffected; add a small pure test
   for the `tieIn/tieOut` boundary computation if it's extracted as a pure fn).

## Risks / tradeoffs / follow-ups

- **Pass 1 still runs for all measures** (line-break needs every measure's
  width). It's VexFlow *measurement* (no DOM), lighter than draw; if it's still
  slow on huge scores, a follow-up could estimate widths cheaply then refine.
  Not addressed here (keep layout fidelity).
- **Re-draw on scroll-back**: a system scrolled out then back re-engraves. Cost
  is bounded to the window; acceptable for linear score reading. `overscan`
  softens it.
- **Partial-tie API** must be confirmed against installed VexFlow 4.2 types.
- **Follow-up task (file):** investigate the real whole-app cold-boot cost
  (~3.1s `page-load`) via `debug/boot-profile` + `VITE_ANALYZE=1` bundle
  treemap — eager JS bytes across the whole plugin registry, unrelated to Sonata.
- **Follow-up (optional):** `songsheet` shares the eager-render trait but is
  cheap (plain React lines); virtualize only if it ever shows jank.

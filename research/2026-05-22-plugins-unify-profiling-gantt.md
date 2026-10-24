# Unify Profiling Sections into a Common Gantt Abstraction

## Context

The debug profiling plugin (`plugins/debug/plugins/profiling/`) has shared Gantt primitives in `web/components/shared.tsx`: `GanttSection`, `TimeAxis`, `useGanttZoom`, `groupByPhase`, etc. The build, boot, and stats sub-plugins use `GanttSection` cleanly — they just pass data and config. But the push sub-plugin (`plugins/push/`) reimplements ~70 lines of zoom/drag/container logic because `GanttSection` couples the container wiring (zoom, drag, pointer capture) with the phase-group row layout. Push needs the former but not the latter — it renders per-worktree rows with two-tone bars and click navigation.

This divergence blocks reuse: a future conversation-toolbar profiling pane needs to render push+build activity filtered by time window and highlighted by worktree, but push rendering can't be composed with the shared primitives.

## Current State: What's Common vs. Different

### Shared across all four sections
- Outer container: `div.relative.select-none` with `ref`, `onPointerDown`, `onDoubleClick`
- Zoom: `useGanttZoom()` → `zoomWindow`, `toLeftPct`, `toWidthPct`, `zoomTo`, `reset`
- Drag-to-zoom: pointer capture, fraction clamping, min-drag threshold (4px)
- Time axis: `TimeAxis` with zoom range display and reset button
- Drag overlay: `DragSelection` component
- Hover state: `ProfilingContext` (`hovered`/`setHovered`)
- Duration formatting: `formatDuration()`
- Bar layout: 160px label | flex-1 bar area | 64px duration column

### Unique to push
- **Row grouping**: by worktree (not by phase). Each row = one worktree with interleaved push + build spans
- **Two-tone push bars**: wait segment (amber, `rounded-l`) + hold segment (outcome-colored, `rounded-r`) as a joined pair
- **Per-row click navigation**: opens conversation or attempt pane
- **Mixed span types**: builds + pushes in one row with outcome-based color semantics
- **No `<1ms hidden` filtering**: all spans rendered unconditionally

### Exact duplication in push-section.tsx (lines 88-162)
- `LABEL_WIDTH = 160`, `DURATION_WIDTH = 64`, `MIN_DRAG_PX = 4` — redeclared identically
- `getBarBounds()` — verbatim copy of the private function in `shared.tsx`
- `handlePointerDown` — verbatim copy of `useGanttDrag` hook body (pointer capture, fraction clamping, zoom callback)
- `useState<DragState | null>(null)` — duplicated drag state
- `onDoubleClick={zoom.isZoomed ? zoom.reset : undefined}` — identical reset pattern
- Outer container structure wrapping `TimeAxis` + rows + `DragSelection`

## Design: `GanttContainer` + Composable Row Primitives

The root cause: `GanttSection` bundles container wiring with `PhaseGroup`/`SpanRow` rendering inseparably. Both are private. The fix: extract `GanttContainer` as the single container abstraction, and export `PhaseGroup`/`SpanRow` as composable row primitives. `GanttSection` stays as convenience sugar — not a separate abstraction, just a preset composition.

### Layer model after refactor

```
GanttContainer (new)               — the single container: zoom + drag + TimeAxis + DragSelection + children
    ├── PhaseGroup (exported)      — composable row primitive: phase header + SpanRow list
    │   └── SpanRow (exported)     — composable row primitive: single span bar
    ├── GanttSection (sugar)       — GanttContainer + PhaseGroup mapping (unchanged API)
    └── PushSection (migrated)     — GanttContainer + PushAttemptRow rows
```

### `GanttContainer` API

```tsx
// gantt-container.tsx

interface GanttContainerProps {
  title: string;
  totalMs: number;
  children: ReactNode;
}

// Provided via context to all children — row primitives read positioning from here
interface GanttContainerContextValue {
  toLeftPct: (ms: number, totalMs: number) => string;
  toWidthPct: (durationMs: number, totalMs: number) => string;
  totalMs: number;
}

function useGanttContainerContext(): GanttContainerContextValue;

function GanttContainer({ title, totalMs, children }: GanttContainerProps): ReactElement;
```

Internally, `GanttContainer` calls `useGanttZoom()`, `useGanttDrag()` (moved here as private), renders `TimeAxis` + `{children}` + `DragSelection`, and provides `toLeftPct`/`toWidthPct`/`totalMs` via context.

### Composable row primitives

`PhaseGroup` and `SpanRow` move from private-in-`shared.tsx` to exported components. They read `toLeftPct`/`toWidthPct`/`totalMs` from `useGanttContainerContext()` instead of props.

```tsx
// PhaseGroup — renders a phase header (dot + label + duration + hidden count) + SpanRow list
interface PhaseGroupProps {
  config: PhaseConfig;
  allSpans: Span[];
  spans: Span[];        // visible (non-zero-duration) spans, sorted by duration desc
}

// SpanRow — renders one bar: 160px label | flex-1 bar | 64px duration
interface SpanRowProps {
  span: Span;
  color: string;        // Tailwind class for the bar
}
```

Both read hover state from `ProfilingContext` and positioning from `GanttContainerContext`.

### Future embedding support

The design enables embedding outside the debug pane:
- **Time-window filtering**: Caller pre-filters data by time range before passing to `GanttContainer`
- **Worktree highlighting**: Push-specific prop on `PushSection` (not a `GanttContainer` concern)
- **External zoom control**: Add optional `externalZoom?: UseGanttZoom` prop when needed — `GanttContainer` always calls its own `useGanttZoom()` but uses `externalZoom` values when provided. Not implemented now (YAGNI), but the API can accept it without breaking changes.

## Implementation Steps

### Step 1: Create `gantt-container.tsx`

**New file**: `plugins/debug/plugins/profiling/web/components/gantt-container.tsx`

- Move `useGanttDrag` function + `LABEL_WIDTH`/`DURATION_WIDTH`/`MIN_DRAG_PX` constants from `shared.tsx` (keep private in this file)
- Create `GanttContainerContext` with `{ toLeftPct, toWidthPct, totalMs }`
- Create `useGanttContainerContext()` accessor hook
- Create `GanttContainer` component:
  ```tsx
  function GanttContainer({ title, totalMs, children }) {
    const zoom = useGanttZoom();
    const containerRef = useRef(null);
    const { drag, handlePointerDown } = useGanttDrag(containerRef, (s, e) => zoom.zoomTo(s, e, totalMs));
    const ctx = useMemo(() => ({ toLeftPct: zoom.toLeftPct, toWidthPct: zoom.toWidthPct, totalMs }), [zoom, totalMs]);
    return (
      <div ref={containerRef} className="relative select-none" onPointerDown={handlePointerDown} onDoubleClick={zoom.isZoomed ? zoom.reset : undefined}>
        <TimeAxis title={title} totalMs={totalMs} zoomWindow={zoom.zoomWindow} onZoomReset={zoom.reset} />
        <GanttContainerContext.Provider value={ctx}>
          {children}
        </GanttContainerContext.Provider>
        <DragSelection drag={drag} />
      </div>
    );
  }
  ```

### Step 2: Refactor `shared.tsx` — export `PhaseGroup`/`SpanRow`, use `GanttContainer`

**Modify**: `plugins/debug/plugins/profiling/web/components/shared.tsx`

- Remove: `useGanttDrag` function, `LABEL_WIDTH`/`DURATION_WIDTH`/`MIN_DRAG_PX`, imports for `useRef`/`useState`/`PointerEvent`/`useGanttZoom`/`DragSelection`/`DragState`
- Import `GanttContainer` and `useGanttContainerContext` from `./gantt-container`
- `PhaseGroup`: export it. Remove `toLeftPct`/`toWidthPct`/`total` props — read from `useGanttContainerContext()` instead. Pass down to `SpanRow` from context.
- `SpanRow`: export it. Remove `toLeftPct`/`toWidthPct`/`total` props — read from `useGanttContainerContext()` directly. Hover state stays via `ProfilingContext` props (passed from `PhaseGroup`).
- `GanttSection` becomes thin sugar:
  ```tsx
  function GanttSection({ title, totalMs, phaseOrder, phaseConfig, allByPhase, visibleByPhase }) {
    const { hovered, setHovered } = useProfilingContext();
    return (
      <GanttContainer title={title} totalMs={totalMs}>
        {phaseOrder.map((phase) => {
          const allSpans = allByPhase.get(phase);
          if (!allSpans || allSpans.length === 0) return null;
          const config = phaseConfig[phase];
          if (!config) return null;
          return (
            <PhaseGroup
              key={phase}
              config={config}
              allSpans={allSpans}
              spans={visibleByPhase.get(phase) ?? []}
            />
          );
        })}
      </GanttContainer>
    );
  }
  ```
- **Public API of `GanttSection` is unchanged** — all existing callers (build, boot, stats) continue working with zero changes

### Step 3: Update barrel

**Modify**: `plugins/debug/plugins/profiling/web/index.ts`

- Add: `export { GanttContainer, useGanttContainerContext } from "./components/gantt-container"`
- Add: `export { PhaseGroup, SpanRow } from "./components/shared"` (newly exported)
- Keep all existing exports (no removals — `DragSelection`/`useGanttZoom` etc. remain available)

### Step 4: Migrate `PushSection`

**Modify**: `plugins/debug/plugins/profiling/plugins/push/web/components/push-section.tsx`

Delete (~70 lines):
- `LABEL_WIDTH`, `DURATION_WIDTH`, `MIN_DRAG_PX` constants (lines 88-90)
- `getBarBounds()` function (lines 116-123)
- `handlePointerDown()` function (lines 125-162)
- `const [drag, setDrag] = useState<DragState | null>(null)` (line 97)
- `const zoom = useGanttZoom()` (line 95)
- `const containerRef = useRef<HTMLDivElement>(null)` (line 96)
- Imports: `useGanttZoom`, `DragSelection`, `DragState`, `TimeAxis`, `useRef`, `PointerEvent`

Add:
- Import `GanttContainer`, `useGanttContainerContext` from `@plugins/debug/plugins/profiling/web`
- Wrap return in `<GanttContainer title="Push & Build" totalMs={data.totalMs}>`

Update `PushAttemptRow`:
- Remove `toLeftPct`/`toWidthPct`/`totalMs` props
- Read from `useGanttContainerContext()` instead

## Files Involved

| File | Action |
|------|--------|
| `plugins/debug/plugins/profiling/web/components/gantt-container.tsx` | **Create** — GanttContainer + context + private useGanttDrag |
| `plugins/debug/plugins/profiling/web/components/shared.tsx` | **Modify** — remove drag logic, export PhaseGroup/SpanRow, refactor GanttSection to use GanttContainer |
| `plugins/debug/plugins/profiling/web/index.ts` | **Modify** — add GanttContainer, PhaseGroup, SpanRow exports |
| `plugins/debug/plugins/profiling/plugins/push/web/components/push-section.tsx` | **Modify** — delete ~70 lines of duplicated logic, use GanttContainer |

**Untouched** (zero changes needed):
- `build-section.tsx`, `boot-section.tsx`, `stats-section.tsx` — call `GanttSection` which has an unchanged public API
- All server-side files
- `use-gantt-zoom.ts`, `drag-selection.tsx` — used internally by `GanttContainer`

## Verification

1. `./equin build` — must succeed with no type errors
2. Open `http://<worktree>.localhost:9000`, navigate to Debug > Profiling
3. Verify all four sections (Build, Boot, Push, Stats) render correctly
4. Verify drag-to-zoom works in all sections (drag across bar area, see zoom range appear)
5. Verify double-click resets zoom in all sections
6. Verify hover highlights spans across sections via `ProfilingContext`
7. Verify push row click navigates to conversation/attempt pane
8. Verify push two-tone bars (amber wait + colored hold) render correctly

# Gantt Chart Drag-to-Zoom

## Context

The profiling Gantt chart (`plugins/debug/plugins/profiling/`) is a debug tool showing build, boot, push, and stats timing spans. Currently it has no zoom — everything renders as 0–100% of `totalMs`. Short spans are invisible when they share a section with a long-running phase. Drag-to-zoom lets users select a time range to magnify, making short spans visible and comparable.

## Approach

Zoom is **per-section local state** (not global) — each section has independent `totalMs` and independent zoom windows. The drag interaction attaches to the section container via pointer capture. A `useGanttZoom` hook encapsulates the zoom state and position transform math. Both `GanttSection` and `PushSection` consume it.

### Zoom-out UX
- **× button** in the TimeAxis header row when zoomed (shows the zoomed range like `200ms–800ms`)
- **Double-click** on the bar area resets to full view
- **Nested zoom** supported — dragging again zooms deeper into the current window

## Files

### New: `plugins/debug/plugins/profiling/web/components/use-gantt-zoom.ts`

Hook managing zoom state for one section.

```ts
interface ZoomWindow { startMs: number; endMs: number }

function useGanttZoom(): {
  zoomWindow: ZoomWindow | null;  // null = full view
  isZoomed: boolean;
  zoomTo(startFraction: number, endFraction: number, totalMs: number): void;
  reset(): void;
  toLeftPct(ms: number, totalMs: number): string;
  toWidthPct(durationMs: number, totalMs: number): string;
}
```

Key behaviors:
- `zoomTo` converts `[0,1]` fractions to absolute ms. When already zoomed, fractions are relative to the current window (enables nested zoom).
- Minimum zoom range: 50ms — smaller selections are rejected (prevents accidental click-zoom).
- `toLeftPct(ms, totalMs)` → `((ms - viewStart) / viewRange) * 100%` when zoomed, `(ms / totalMs) * 100%` otherwise.
- `toWidthPct(durationMs, totalMs)` → `(durationMs / viewRange) * 100%` when zoomed, with 0.3% minimum floor preserved.

### New: `plugins/debug/plugins/profiling/web/components/drag-selection.tsx`

Small component rendering the live selection highlight during drag. Positioned absolutely within the section, offset to cover only the bar column area (`left: 10rem` / `right: 4rem` matching the `w-40` / `w-16` columns).

```tsx
function DragSelection({ drag }: { drag: { start: number; current: number } | null })
```

Renders a translucent blue rectangle (`bg-blue-500/15 border-x border-blue-400/60`) when `drag` is non-null. Pure visual — no event handling.

### Modify: `plugins/debug/plugins/profiling/web/components/shared.tsx`

**GanttSection** — add zoom state and drag interaction:
- Call `useGanttZoom()` internally
- Wrap content in a `relative` container with `onPointerDown` handler
- On `pointerdown`: check click is within bar column bounds (between label and duration columns), initiate pointer capture, record start fraction
- On `pointermove`: update drag `current` fraction
- On `pointerup`: commit to `zoomTo()`, clear drag state
- On double-click (`e.detail === 2`): call `reset()` instead of starting drag
- Render `<DragSelection>` overlay inside the relative wrapper
- Thread `toLeftPct` / `toWidthPct` through `PhaseGroup` → `SpanRow`

**TimeAxis** — add zoom awareness:
- New optional props: `zoomWindow`, `onZoomReset`
- When zoomed: ticks span `viewStart → viewEnd` instead of `0 → totalMs`
- Tick positions: `((ms - viewStart) / viewRange) * 100%`
- Label area shows zoomed range + × reset button instead of full duration

**SpanRow** — accept transform functions:
- Replace hard-coded `(span.startMs / total) * 100%` with `toLeftPct(span.startMs, total)`
- Replace hard-coded width calc with `toWidthPct(span.durationMs, total)`

**PhaseGroup** — thread `toLeftPct`/`toWidthPct` props through to SpanRow.

### Modify: `plugins/debug/plugins/profiling/plugins/push/web/components/push-section.tsx`

Same pattern as GanttSection:
- Call `useGanttZoom()` in `PushSection`
- Wrap content in a `relative` container with the same pointer-capture drag logic
- Thread zoom into `PushTimeAxis` (same tick transform) and `PushAttemptRow` (replace inline bar percent calculations with `toLeftPct`/`toWidthPct`)
- Add `<DragSelection>` overlay
- Double-click resets

### Modify: `plugins/debug/plugins/profiling/web/index.ts`

Export `useGanttZoom` if the push section needs to import it (it will, since push-section.tsx imports from `@plugins/debug/plugins/profiling/web`).

## Drag interaction detail

The pointer capture attaches to the section container (not a separate overlay element), avoiding any interference with span bar hover events (`onMouseEnter`/`onMouseLeave` for `hovered` state).

```
pointerdown on section container:
  1. Check e.clientX is within bar column bounds (skip if in label/duration column)
  2. If e.detail === 2: call reset(), return
  3. setPointerCapture(e.pointerId)
  4. Compute start fraction: (e.clientX - barLeft) / barWidth
  5. Set drag state: { start, current: start }

pointermove:
  6. Update drag.current fraction

pointerup:
  7. Release pointer capture
  8. If |end - start| > threshold: call zoomTo(start, end, totalMs)
  9. Clear drag state
```

The bar column bounds are computed from the container ref: `barLeft = rect.left + 160px`, `barRight = rect.right - 64px` (matching `w-40` / `w-16`).

## Edge cases

- **Division by zero**: `toLeftPct`/`toWidthPct` return `"0%"` when `totalMs === 0` or `viewRange === 0`
- **Nested zoom**: fractions in `zoomTo` are interpreted relative to the current window, not the full range
- **Bars outside view**: negative or >100% positions clip naturally via `overflow-hidden` on the bar container (already set)
- **Accidental clicks**: selections < 50ms or < 4px are ignored
- **Hover during drag**: pointer capture routes events to the container; span bars won't receive `mouseenter` during drag, which is fine — hover detail is irrelevant while selecting

## Verification

1. `./equin build` to deploy
2. Open `http://<worktree>.localhost:9000` → Debug → Profiling
3. Test: drag across a time range in any section → view should zoom to that range
4. Test: × button in the time axis header resets zoom
5. Test: double-click in the bar area resets zoom
6. Test: drag again while zoomed → nested zoom works
7. Test: hover on span bars still shows detail in the footer (when not dragging)
8. Test: push section zoom works independently from boot/build sections
9. Test: refresh button reloads data and preserves/resets zoom appropriately

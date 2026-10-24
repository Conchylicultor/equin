# Fix ResponsiveOverflow re-expansion

## Context

The `ResponsiveOverflow` primitive correctly hides children when the container shrinks, but hidden children never reappear when space opens back up. The container uses `inline-flex`, so its width = content width. After hiding children, the container shrinks to match. ResizeObserver only fires on size changes — since the shrunken container never grows on its own, the observer goes silent.

A probe+ancestor approach (DOM walking with 1.5x heuristic) was prototyped and reverted as fragile.

## Design

Two concerns, separated:

1. **Observation (when did space change?):** Observe the container (detects shrink) AND `container.parentElement` (detects grow). The parent is block/flex-level and grows when the viewport grows. One extra `ro.observe()` call.

2. **Measurement (how much space is available?):** On resize callback, temporarily set `container.style.flex = '1 1 0'`, read `offsetWidth` (forced reflow — the flex algorithm gives us exactly the available space), restore. The browser never paints the greedy state because mutate+read+restore happens within one rAF before paint.

The container stays `inline-flex` — visually compact, no gap. No consumer changes to the ResponsiveOverflow usage. Optional `constraintRef` escape hatch for edge cases where the parent observation doesn't work (e.g. `display:contents` parent).

## Changes

### 1. Hook: parent observation + temporarily-greedy measurement

**File:** `plugins/primitives/plugins/responsive-overflow/web/internal/responsive-overflow.tsx`

Keep the container as `inline-flex min-w-0 overflow-hidden` (no change).

Add optional `constraintRef?: RefObject<HTMLElement | null>` to `UseResponsiveOverflowOptions` and `ResponsiveOverflowProps` (escape hatch only).

Rewrite `useLayoutEffect`:

```ts
useLayoutEffect(() => {
  const container = containerRef.current;
  const measure = measureRef.current;
  if (!container || !measure) return;
  if (constraintRef && !constraintRef.current) return;

  const recompute = () => {
    let available: number;
    if (constraintRef?.current) {
      // Escape hatch: read directly from constraint element
      available = constraintRef.current.offsetWidth;
    } else {
      // Temporarily go greedy to measure available space
      const saved = container.style.cssText;
      container.style.flex = '1 1 0';
      container.style.minWidth = '0';
      available = container.offsetWidth;
      container.style.cssText = saved;
    }

    const items = Array.from(measure.children) as HTMLElement[];
    // ... same fit-count logic against `available` ...
  };

  let rafId: number | null = null;
  const ro = new ResizeObserver(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(recompute);
  });

  if (constraintRef?.current) {
    ro.observe(constraintRef.current);
  } else {
    ro.observe(container);
    // Also observe parent to detect when space opens up
    const parent = container.parentElement;
    if (parent) ro.observe(parent);
  }

  recompute();
  return () => {
    ro.disconnect();
    if (rafId !== null) cancelAnimationFrame(rafId);
  };
}, [count, gap, constraintRef]);
```

Pass `constraintRef` through from the component to the hook.

### 2. ToolbarRow wrapper: propagate width

**File:** `plugins/primitives/plugins/prompt-editor/web/components/prompt-editor.tsx` (line 91)

The slot contribution wrapper div is content-sized. Add `flex-1 min-w-0` so it fills the toolbar and the parent chain propagates width:

```tsx
// Before
<div className={cn(!editable && !item.alwaysActive && disabledPartCls)}>

// After
<div className={cn("flex-1 min-w-0", !editable && !item.alwaysActive && disabledPartCls)}>
```

### 3. Consumer: revert `flex-1` (no longer needed)

**File:** `plugins/conversations/plugins/conversation-view/plugins/prompt-templates/web/components/prompt-template-chips.tsx`

Revert to original — no `flex-1` needed on the ResponsiveOverflow:

```tsx
<ResponsiveOverflow gap={4} className="items-center">
```

The primitive handles re-expansion internally.

## Width propagation chain (after fix)

```
EditorShell (w-full min-w-0)
  ToolbarRow (flex items-center px-2 pb-1.5)              tracks viewport
    [display:contents SortableItem wrappers]               transparent
      wrapper div (flex-1 min-w-0)                         fills toolbar       ← CHANGED
        FloatingTemplateChips (flex items-center gap-1.5)  fills wrapper (block in normal flow)
          ResponsiveOverflow (inline-flex min-w-0)         compact, content-sized
          FloatingAction                                   fixed width
```

## How re-expansion works

- **Viewport shrinks →** parent shrinks → ResizeObserver fires (parent observation) → temporarily-greedy measure → available is smaller → hide children → container shrinks → ResizeObserver fires again (container observation) → confirms stable
- **Viewport grows →** parent grows → ResizeObserver fires (parent observation) → temporarily-greedy measure → available is larger → show more children → container grows → ResizeObserver fires again (container observation) → confirms stable
- **After hiding children →** container shrinks (inline-flex). Parent stays the same (block-level). No oscillation — parent didn't change, container change is one-shot.

## Why no flicker

The temporarily-greedy measurement happens inside a `requestAnimationFrame` callback:
1. Set `container.style.flex = '1 1 0'`
2. Read `container.offsetWidth` (forced synchronous reflow — layout computed in memory)
3. Restore `container.style.cssText`
4. `setVisibleCount()` → React re-renders → browser paints

The browser never paints between steps 1-3. Same pattern as `useLayoutEffect` measure-before-paint.

## Verification

1. `./equin build`
2. Open a conversation with pinned prompt templates
3. Resize the browser window narrower — chips should hide progressively
4. Resize wider — chips should reappear as space opens up
5. Verify chips stay compact (no visual gap before the FloatingAction icon)
6. Verify the FloatingAction icon button stays visible at all widths

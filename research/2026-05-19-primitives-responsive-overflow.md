# Responsive Overflow Primitive

## Context

The prompt-templates plugin renders pinned template chips in a flex row inside the prompt bar. When the window is narrow, chips overflow without collapsing — leaving padding artifacts or pushing layout. The user wants chips to progressively disappear when space is tight, with no empty space left behind.

A reusable primitive extracts this pattern so any plugin can use it.

## Approach

New primitive plugin: `plugins/primitives/plugins/responsive-overflow/`

Mirrors the proven `OverflowActionsBar` pattern from `plugins/primitives/plugins/pane/web/components/pane-chrome.tsx:166` — portal-based off-screen measurement + ResizeObserver + `useLayoutEffect` for flash-free initial render.

### API

```tsx
// Component — primary API
<ResponsiveOverflow gap={4} className="items-center">
  <Chip>A</Chip>
  <Chip>B</Chip>
  <Chip>C</Chip>
</ResponsiveOverflow>

// Hook — for consumers needing full rendering control
const { containerRef, measureRef, visibleCount } = useResponsiveOverflow({
  count: items.length,
  gap: 4,
});
```

The component renders `inline-flex min-w-0` (not `flex-1`) — it takes the natural width of visible children only, so hidden items leave zero space.

No overflow indicator ("+N more") — the primitive just hides. Consumers add their own if needed.

### Key design decisions

- **Portal measurement**: all children rendered in an off-screen `position: fixed; top: -9999` portal for natural width measurement, same as pane-chrome.
- **`useLayoutEffect` + synchronous `recompute()`**: prevents visible flash on mount.
- **`requestAnimationFrame` debounce**: on observer callbacks to avoid ResizeObserver loop warnings.
- **`children: ReactNode[]`**: explicit array type — `.map()` returns satisfy this naturally.
- **`gap` as number (pixels)**: applied via `style={{ gap }}` on both portal and real container. No Tailwind class for gap — keeps measurement aligned.

## New files

### `plugins/primitives/plugins/responsive-overflow/package.json`

```json
{
  "name": "@singularity/plugin-primitives-responsive-overflow",
  "description": "Progressively hides children that don't fit the container width.",
  "private": true,
  "version": "0.0.1"
}
```

### `plugins/primitives/plugins/responsive-overflow/web/index.ts`

Barrel exporting `ResponsiveOverflow`, `useResponsiveOverflow`, and their types. Default export: `PluginDefinition` with `id: "responsive-overflow"`, `contributions: []`.

### `plugins/primitives/plugins/responsive-overflow/web/internal/responsive-overflow.tsx`

**`useResponsiveOverflow({ count, gap })`** — hook:
- Owns `containerRef`, `measureRef`, `visibleCount` state
- `useLayoutEffect` creates ResizeObserver on `containerRef`, runs `recompute()` synchronously
- `recompute()`: reads `container.offsetWidth`, iterates `measure.children` widths + gaps, finds largest fitting prefix
- Observer callback deferred via `requestAnimationFrame`
- Deps: `[count, gap]`

**`ResponsiveOverflow({ children, gap, className })`** — component:
- Calls `useResponsiveOverflow`
- Portal: renders all children in off-screen flex row for measurement
- Real container: `<div ref={containerRef} className={cn("inline-flex min-w-0 overflow-hidden", className)} style={{ gap }}>` with `children.slice(0, visibleCount)`

## Modified file

### `plugins/conversations/plugins/conversation-view/plugins/prompt-templates/web/components/prompt-template-chips.tsx`

Replace the pinned chips `<div className="flex items-center gap-1">` with `<ResponsiveOverflow gap={4} className="items-center">`. Import from `@plugins/primitives/plugins/responsive-overflow/web`.

The `pinnedCount` config remains — it controls the max slice. ResponsiveOverflow further reduces visible count based on space.

## Verification

1. `./equin build` — regenerates plugin registry, type-checks
2. Wide window: all pinned chips visible, identical to before
3. Narrow window: chips disappear from the right, no empty space
4. No flash on initial render (useLayoutEffect)
5. No ResizeObserver loop warnings in console
6. Zero / one chip edge cases
7. FloatingAction button (pen icon) unaffected

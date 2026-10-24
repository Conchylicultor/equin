# Fix: Reorder edit-mode toggle remounts all slot contributions

## Context

Toggling the reorder pen button (edit mode on/off) causes the terminal pane to reopen. The root cause is in `ReorderItemMiddleware`: it switches wrapper element type between `<>{children}</>` (Fragment) and `<SortableReorderItem>` (div-based) when `editMode` flips. React can't reconcile Fragment vs div, so it unmounts and remounts every slot contribution. `TerminalButton` has a `useRef`-based auto-open guard that resets on remount, re-firing `openPane`.

Investigation confirmed `TerminalButton` is the only component currently affected (only mount-time `openPane` with a ref guard), but the middleware remount is a framework-level footgun.

## Plan

Three files, minimal changes.

### 1. `plugins/reorder/web/internal/dnd-item-middleware.tsx`

Remove the conditional Fragment return for the `!editMode` case. Always render `SortableReorderItem`, passing `editMode` as a prop:

```tsx
if (!key) return <>{children}</>;
if (excluded) return <>{children}</>;
return (
  <SortableReorderItem itemKey={key} storageId={ctx?.storageId ?? ""} editMode={editMode}>
    {children}
  </SortableReorderItem>
);
```

### 2. `plugins/reorder/web/internal/dnd-components.tsx` — `SortableReorderItem`

Accept `editMode: boolean` prop. Always render `<SortableItem>` (stable div). Inside the render prop, keep `children` at a fixed index position (index 1) so React reconciles it in place regardless of editMode. Conditional siblings (hide button at index 0, GroupingZone at index 2) toggle between `false` and an element — React handles this without affecting index 1.

```tsx
export function SortableReorderItem({
  itemKey, storageId, editMode, children,
}: {
  itemKey: string; storageId: string; editMode: boolean; children: ReactNode;
}) {
  function handleHide(e: React.MouseEvent) { /* unchanged */ }

  return (
    <SortableItem
      id={itemKey}
      className={editMode ? "group/reorder-item relative cursor-grab rounded-md ring-1 ring-primary/50" : undefined}
    >
      {({ isDragging }) => (
        <>
          {editMode && (
            <button className="absolute -top-1.5 -right-1.5 z-10 ..." onPointerDown={...} onClick={handleHide}>
              <MdClose className="size-2.5" />
            </button>
          )}
          <div className={editMode ? cn("pointer-events-none", isDragging && "opacity-40") : undefined}>
            {children}
          </div>
          {editMode && <GroupingZone itemKey={itemKey} />}
        </>
      )}
    </SortableItem>
  );
}
```

Key structural decisions:
- **Ring/grab on SortableItem div** (not an inner div) — collapses the original 3-level nesting to 2. Drag listeners live on SortableItem's div, so `cursor-grab` belongs there. `pointer-events-none` on the content div prevents children from intercepting the grab.
- **Hide button absolute-positioned** relative to SortableItem div (which has `relative` in edit mode).
- **Children always at JSX index 1** — `{false}` at indices 0 and 2 in non-edit mode. React reconciles the div at index 1 in place; children inside it never remount.
- **One content div always present** around children (no classes in non-edit mode). Unavoidable for stable reconciliation — switching between "no wrapper" and "div wrapper" is exactly the type change we're fixing.

### 3. `plugins/primitives/plugins/sortable-list/web/internal/sortable-item.tsx`

When disabled, `useDraggable` returns `listeners: undefined` but still returns `attributes` with `role="button"`, `tabIndex=0`, `aria-disabled=true`. Spreading these on every non-edit contribution wrapper is semantically wrong. Fix by checking `listeners`:

```tsx
const wrapperProps = handle ? {} : (listeners ? { ...attributes, ...listeners } : {});
```

## DOM impact in non-edit mode

Each non-excluded contribution gets one extra `<div>` (from SortableItem) and one inner `<div>` (content wrapper), both with no classes or event listeners. The SortableItem div has `style=""` (null transform). This is layout-transparent for flex/grid parents since the divs are unstyled block elements containing a single child.

## Verification

1. `./equin build`
2. Open a conversation with the terminal pane auto-opened
3. Toggle the reorder pen button on and off — terminal pane should NOT reopen
4. In edit mode: verify drag reorder still works, hide button appears, ring visual shows, grouping zones work
5. Exit edit mode: verify no visual artifacts, contributions render normally
6. Check other slots (sidebar entries, toolbar buttons) for layout regressions

# Reorder Mode: Show Labels for Conditionally Hidden Elements

## Context

In reorder (edit) mode, every slot contribution is wrapped in a `SortableReorderItem` ring box — even contributions whose component returns `null` at render time (e.g., `TaskGraph` only renders when a task has dependencies). These null-rendering contributions appear as empty ring boxes with just a hide-X button and no content, making them unidentifiable.

This is distinct from contributions the user explicitly hid via the reorder system (those appear in the RestoreButton panel and are not rendered at all). The problem is specifically contributions that are registered and visible in the reorder ordering, but whose component conditionally renders nothing.

## Approach

Detect empty contributions at the DOM level inside `SortableReorderItem` and show a muted label placeholder when the content wrapper has no child nodes.

**Why DOM-level detection:** The `children` prop passed to `SortableReorderItem` is always a React element tree (e.g., `<TaskGraph taskId={...} />`), never `null` — the component returns null during React rendering, not during JSX construction. There is no React-level API to pre-check if a component tree will render nothing.

## Files to Modify

### 1. `plugins/reorder/web/internal/dnd-components.tsx`

**Add `label` prop to `SortableReorderItem`:**
```ts
export function SortableReorderItem({
  itemKey, storageId, editMode,
  label,  // NEW
  wrapperClassName, children,
}: {
  // ... existing props ...
  label: string;  // NEW
})
```

**Add empty-content detection (inside the component):**
```ts
const ctx = useContext(ReorderAreaContext);
const isHorizontal = ctx?.orientation === "horizontal";
const contentRef = useRef<HTMLDivElement>(null);
const [isEmpty, setIsEmpty] = useState(false);

useLayoutEffect(() => {
  if (!editMode) {
    setIsEmpty(false);
    return;
  }
  const el = contentRef.current;
  if (!el) return;

  const check = () => setIsEmpty(el.childNodes.length === 0);
  check();

  const observer = new MutationObserver(check);
  observer.observe(el, { childList: true });
  return () => observer.disconnect();
}, [editMode]);
```

**Change the content wrapper div — remove `contents` class in edit mode** so the ref div participates in layout and child node detection works:
```tsx
<div
  ref={contentRef}
  className={cn(editMode ? "pointer-events-none" : "contents")}
>
  {children}
</div>
```

Removing `contents` in edit mode is safe because the outer `SortableItem` already renders a real box with `ring-1 ring-primary/50 rounded-md` — contributions are not direct flex children of the toolbar/section container in edit mode regardless.

**Render label placeholder when empty:**
```tsx
{editMode && isEmpty && (
  <div
    className={cn(
      "pointer-events-none select-none italic text-muted-foreground/50",
      isHorizontal
        ? "px-2 py-0.5 text-[10px] whitespace-nowrap"
        : "px-3 py-1.5 text-center text-xs",
    )}
  >
    {label}
  </div>
)}
```

Place this between the content div and `<GroupingZone />`.

### 2. `plugins/reorder/web/internal/dnd-item-middleware.tsx`

**Pass `label` to `SortableReorderItem`:**
```ts
import { contributionKey, contributionLabel } from "./sorting";

// Inside ReorderItemMiddleware:
const label =
  (contribution as Record<string, unknown>).label as string | undefined
  ?? contributionLabel(contribution);

return (
  <SortableReorderItem
    itemKey={key}
    storageId={ctx?.storageId ?? ""}
    editMode={editMode}
    label={label}  // NEW
    wrapperClassName={wrapperClassName}
  >
    {children}
  </SortableReorderItem>
);
```

`contributionLabel()` from `sorting.ts` returns `_pluginName ?? id ?? "Item"`. The `contribution.label` fallback catches detail-sections contributions which carry a user-facing `label` field (e.g., "Task Graph", "Dependencies").

## Label Resolution Order

1. `contribution.label` (user-facing section label from detail-sections)
2. `contribution._pluginName` (plugin display name)
3. `contribution.id` (bare contribution ID)
4. `"Item"` (fallback)

## Edge Cases

- **Component becomes non-null later** (e.g., task gains dependencies): MutationObserver fires when React inserts DOM nodes, clears `isEmpty` automatically.
- **Component becomes null** (e.g., dependency removed): MutationObserver fires on child removal, sets `isEmpty`.
- **Non-edit mode**: `useLayoutEffect` returns early, no observer, no overhead.
- **Horizontal layouts**: Compact single-line label with `text-[10px]` and `whitespace-nowrap`.
- **Vertical layouts**: Centered label with `text-xs` and vertical padding.

## Verification

1. `./equin build`
2. Open a task detail pane for a task **without** dependencies (so TaskGraph returns null)
3. Click the pen (edit mode) button in the toolbar
4. Verify: the empty ring box for TaskGraph now shows a muted italic label like "Task Graph"
5. Verify: non-empty contributions still render normally (no label overlay)
6. Add a dependency to the task, verify: the label disappears as TaskGraph renders its content
7. Test a horizontal slot (e.g., the conversation toolbar) — verify labels are compact
8. Verify: explicitly hidden items (via X button) still go to the RestoreButton panel, not shown as labels

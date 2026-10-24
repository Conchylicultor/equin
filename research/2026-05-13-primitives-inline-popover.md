# InlinePopover Primitive

## Context

Nine feature plugins import `Popover + PopoverContent + PopoverTrigger` directly from `@/components/ui/popover` and assemble the same three-component nesting pattern each time. A shared `<InlinePopover>` primitive collapses that into a single import and a single component, enforcing consistent positioning defaults without restricting flexibility.

**Plugins affected:**
| Plugin file | align | contentClassName |
|---|---|---|
| `plugins/reorder/web/internal/dnd-components.tsx` | `start` | `w-56 p-0` |
| `plugins/tasks/plugins/task-draft-form/web/components/task-draft-popover.tsx` | default | (none) |
| `plugins/crashes/plugins/launch-fix/web/components/launch-fix-button.tsx` | `end` | `w-[420px] max-w-[90vw] space-y-3 p-3` |
| `plugins/conversations/.../blocking/web/components/blocking-button.tsx` | `end` | `w-96 p-2` |
| `plugins/conversations/.../blocked-by/web/components/blocked-by-button.tsx` | `end` | `w-96 p-2` |
| `plugins/conversations/.../jsonl-viewer/web/components/raw-json-button.tsx` | `end` | `w-[640px] max-w-[90vw] p-0` |
| `plugins/conversations/plugins/conversation-category/web/components/category-chip-toolbar.tsx` | `start` | `w-56 p-1` |
| `plugins/build/web/components/build-button.tsx` | `end` | `w-[480px] p-0` |
| `plugins/notifications/web/components/bell-button.tsx` | `end` | `w-80 p-0` |

Key observations from the audit:
- No call-site overrides `sideOffset` (all use the base default of 4).
- `side` is never overridden either — `"bottom"` is both the default and the only value used.
- `align` is always `"start"` or `"end"`; rarely the default.
- Content width is always set explicitly — no sensible default should be imposed.
- Content padding is almost always overridden — `p-0` dominates, `p-3` (the base default) is used only where no explicit className is passed.

## Implementation Plan

### Step 1 — Create the primitive plugin

**`plugins/primitives/plugins/popover/package.json`**
```json
{
  "name": "@singularity/plugin-primitives-popover",
  "description": "InlinePopover wrapper: single-import Popover + Trigger + Content with sensible defaults.",
  "private": true,
  "version": "0.0.1"
}
```

**`plugins/primitives/plugins/popover/web/internal/inline-popover.tsx`**

```tsx
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ComponentProps } from "react";

type PopoverContentProps = ComponentProps<typeof PopoverContent>;

interface InlinePopoverProps {
  /** Trigger element — open/close behavior is merged via base-ui render prop. */
  trigger: React.ReactElement;
  /** Popover panel content. */
  children: React.ReactNode;
  /** Horizontal alignment of the panel relative to the trigger. Default: "start". */
  align?: PopoverContentProps["align"];
  /** Side to open on. Default: "bottom". */
  side?: PopoverContentProps["side"];
  /** Extra classes forwarded to PopoverContent (width, padding, etc.). */
  contentClassName?: string;
  /** Controlled open state — omit for uncontrolled. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function InlinePopover({
  trigger,
  children,
  align = "start",
  side = "bottom",
  contentClassName,
  open,
  onOpenChange,
}: InlinePopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={trigger} />
      <PopoverContent align={align} side={side} className={cn(contentClassName)}>
        {children}
      </PopoverContent>
    </Popover>
  );
}
```

> The `render` prop on `PopoverTrigger` follows the base-ui pattern (same as `WithTooltip` in `plugins/primitives/plugins/tooltip/web/components/with-tooltip.tsx`). It merges the popover's open/close handler and ARIA attributes onto the passed element, preserving any custom `className`, `onClick`, `disabled`, etc. already on it.

**`plugins/primitives/plugins/popover/web/index.ts`**

```ts
import type { PluginDefinition } from "@core";

export { InlinePopover, type InlinePopoverProps } from "./internal/inline-popover";

export default {
  id: "primitives/popover",
  name: "InlinePopover",
  description: "Single-import wrapper for the shadcn Popover + Trigger + Content pattern with sensible defaults.",
  contributions: [],
} satisfies PluginDefinition;
```

### Step 2 — Migrate each of the 9 plugins

For every plugin in the table above, make two changes:

1. **Replace the import:**
   ```ts
   // Before
   import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
   // After
   import { InlinePopover } from "@plugins/primitives/plugins/popover/web";
   ```

2. **Flatten the JSX pattern:**
   ```tsx
   // Before
   <Popover open={open} onOpenChange={setOpen}>
     <PopoverTrigger className="..." title="...">…content…</PopoverTrigger>
     <PopoverContent className="w-96 p-2" align="end">…panel…</PopoverContent>
   </Popover>

   // After
   <InlinePopover
     trigger={<button className="..." title="...">…content…</button>}
     open={open}
     onOpenChange={setOpen}
     align="end"
     contentClassName="w-96 p-2"
   >
     …panel…
   </InlinePopover>
   ```

   The key transformation: whatever element `PopoverTrigger` was rendering becomes the `trigger` prop element (a plain `<button>`, a custom component, etc.). All props that were on `PopoverTrigger` move to that element directly.

**Per-plugin notes:**

- **`raw-json-button`** — currently uncontrolled (no `open` state). Keep it uncontrolled: omit `open`/`onOpenChange` from `InlinePopover`. The trigger has `onClick={(e) => e.stopPropagation()}` — move that onto the button in `trigger`.
- **`task-draft-popover`** — receives a `trigger: ReactNode` prop plus a separate `triggerClassName`. Wrap them: `trigger={<button className={triggerClassName} title={triggerTitle} aria-label={triggerTitle}>{triggerNode}</button>}`.
- **`launch-fix-button`** — has `disabled` on the trigger. Keep it on the button element: `trigger={<button disabled={disabled} className="...">Fix</button>}`.
- **`bell-button`** — explicitly passes `side="bottom"` (which is already the default). Drop it in the migrated version.

### Step 3 — Build and verify

```bash
./equin build
```

Checks the plugin is auto-discovered, migrations are in sync, and ESLint passes.

## Verification

1. `./equin build` completes with no errors.
2. `./equin check` passes (plugin-boundaries, eslint).
3. In the browser, click each of the 9 popover trigger buttons and confirm the panel opens/closes correctly:
   - Reorder restore button
   - Task draft form launch button
   - Crash "Fix" button
   - Blocking / Blocked-by toolbar buttons
   - Raw JSON action in the JSONL viewer
   - Conversation category chip (toolbar)
   - Build button
   - Notification bell

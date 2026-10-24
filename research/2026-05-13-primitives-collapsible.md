# Collapsible Primitive

## Context

15+ hand-rolled collapsible patterns all follow the same shape: `useState(bool)` + `{open && ...}` + chevron `rotate-90`. None use animation. ARIA coverage is spotty (only 3/15 set `aria-expanded`; none use `aria-controls`). A shared primitive would give consistent accessibility, optional height animation, and a single place to evolve the pattern.

`@radix-ui/react-collapsible@1.1.12` is already in the dep tree via the `radix-ui` umbrella.

## Design

Two complementary APIs:

1. **Compound components** wrapping Radix Collapsible — `<Collapsible>`, `<CollapsibleTrigger>`, `<CollapsibleContent>`, `<CollapsibleChevron>`. Best for new code with standard trigger layout. Provides animated content via `--radix-collapsible-content-height` CSS variable.

2. **`useCollapsible` hook** — returns `{ open, toggle, triggerProps, contentId, chevronClassName }`. Best for existing code with custom trigger elements (SidebarGroupLabel, full-row buttons, tree nodes). Consumers keep using `{open && ...}` for content. The hook's job is consistent ARIA attributes + controlled/uncontrolled support.

Persistence (localStorage, server) is a consumer concern — the primitive only manages open/close state.

## Files to create

### `plugins/primitives/plugins/collapsible/package.json`
```json
{ "name": "@singularity/plugin-primitives-collapsible", "private": true, "version": "0.0.1" }
```

### `plugins/primitives/plugins/collapsible/web/internal/use-collapsible.ts`

```ts
interface UseCollapsibleOptions {
  defaultOpen?: boolean;       // uncontrolled initial value (default: false)
  open?: boolean;              // controlled value
  onOpenChange?: (open: boolean) => void;
}
interface UseCollapsibleReturn {
  open: boolean;
  toggle: () => void;
  triggerProps: { type: "button"; "aria-expanded": boolean; "aria-controls": string; onClick: () => void };
  contentId: string;           // consumers put id={contentId} on content wrapper
  chevronClassName: string;    // "transition-transform duration-200 rotate-90" or "transition-transform duration-200"
}
```

- Controlled/uncontrolled: `open !== undefined` determines mode
- `contentId` via `useId()`
- Consumers continue conditional-rendering content with `{open && <div id={contentId}>...}` — no `hidden` attr, no forced DOM mounting

### `plugins/primitives/plugins/collapsible/web/internal/collapsible.tsx`

Thin wrappers around `@radix-ui/react-collapsible`:

- `Collapsible` — wraps `Root`, passes through `open`/`onOpenChange`/`defaultOpen` + `data-slot`
- `CollapsibleTrigger` — wraps `Trigger`, adds `data-slot` + default flex layout
- `CollapsibleContent` — wraps `Content`, adds height animation via Radix CSS variables:
  ```
  data-[state=open]:animate-in data-[state=open]:fade-in-0
  data-[state=closed]:animate-out data-[state=closed]:fade-out-0
  ```
  Plus `overflow-hidden` and `transition-[height]` using `--radix-collapsible-content-height`
- `CollapsibleChevron` — `ChevronRight` (lucide) that reads `data-state` from nearest Radix trigger ancestor:
  ```
  [[data-state=open]>&]:rotate-90
  ```
  Also accepts explicit `open` prop for use outside compound components (hook API consumers)

### `plugins/primitives/plugins/collapsible/web/internal/collapsible.css`

Per the theme CLAUDE.md, plugin animations belong in the plugin. A small CSS file for the height transition keyframes, imported from `collapsible.tsx`.

### `plugins/primitives/plugins/collapsible/web/index.ts`

Barrel: re-exports all components + hook + types. Default export: `{ id: "collapsible", name: "Collapsible", description: "...", contributions: [] }`.

### `plugins/primitives/plugins/collapsible/CLAUDE.md`

Standard plugin reference doc.

## Migrations (3 consumers)

### 1. `AssistantThinkingRow` — simplest, uncontrolled hook

File: `plugins/.../assistant-thinking/web/components/assistant-thinking-row.tsx`

Replace `useState(false)` + manual button + `{open && ...}` with `useCollapsible()`. Spread `triggerProps` onto `<button>`, use `chevronClassName` on the icon, add `id={contentId}` to the content div. Keep `{open && ...}` conditional render.

### 2. `SidebarPaneSection` — uncontrolled hook with custom trigger element

File: `plugins/primitives/plugins/app-shell/web/components/sidebar-pane-section.tsx`

Replace `useState(defaultOpen)` with `useCollapsible({ defaultOpen })`. Apply `onClick`/`aria-expanded`/`aria-controls` from `triggerProps` individually onto `SidebarGroupLabel` (it's a div, not a button). Replace `MdChevronRight` with `CollapsibleChevron` using `chevronClassName`.

### 3. `QueueView/SectionHeader` — controlled, chevron swap

File: `plugins/.../queue/web/components/queue-view.tsx`

`SectionHeader` already accepts `expanded`+`onToggleExpanded` (controlled). Add `data-state={expanded ? "open" : "closed"}` on the trigger button + `aria-expanded={expanded}`. Replace `MdChevronRight` with `CollapsibleChevron open={expanded}`. Remove direct `MdChevronRight` import.

## Implementation sequence

1. Create plugin skeleton (package.json, CLAUDE.md)
2. Implement `useCollapsible` hook
3. Implement compound components + CSS
4. Create barrel `web/index.ts`
5. `./equin build` — validates plugin registration
6. Migrate AssistantThinkingRow
7. Migrate SidebarPaneSection
8. Migrate QueueView/SectionHeader
9. `./equin build` + smoke-test in browser

## Verification

1. `./equin build` succeeds
2. Open `http://att-1778658514-wf02.localhost:9000`
3. Verify thinking blocks collapse/expand in a conversation with thinking
4. Verify sidebar sections collapse/expand
5. Verify queue view sections collapse/expand
6. Check ARIA attributes in browser devtools (aria-expanded, aria-controls with matching id)

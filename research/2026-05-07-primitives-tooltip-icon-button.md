# Tooltip + IconButton primitive plugins

## Context

The codebase has a 7-line boilerplate pattern for icon buttons with tooltips:

```tsx
<Tooltip>
  <TooltipTrigger render={<Button variant="ghost" size="icon" aria-label="Draw on app" ...>
    <MdGesture className="size-4" />
  </Button>} />
  <TooltipContent>Draw on app</TooltipContent>
</Tooltip>
```

This appears in 10+ files. It should be one line:

```tsx
<IconButton icon={MdGesture} label="Draw on app" disabled={active} onClick={() => setActive(true)} />
```

Two new primitives: a `tooltip` plugin (re-exports + `<Kbd>` component) and an `icon-button` plugin (composed component).

## Plugin 1: `tooltip`

**Location:** `plugins/primitives/plugins/tooltip/`

Re-exports `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider` from `@/components/ui/tooltip` so plugin-land has a canonical import path. Adds a `<Kbd>` component for keyboard shortcut badges — the CSS is already wired in `TooltipContent` via `data-slot="kbd"`.

### `web/components/kbd.tsx`

```tsx
interface KbdProps { className?: string; children: ReactNode }

function Kbd({ className, children }: KbdProps) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "ml-auto inline-flex h-5 select-none items-center gap-1 rounded border border-background/30 bg-background/20 px-1 font-mono text-[0.65rem] font-medium text-background",
        className
      )}
    >
      {children}
    </kbd>
  );
}
```

### `web/index.ts`

```ts
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
export { Kbd, type KbdProps } from "./components/kbd";

export default {
  id: "tooltip",
  name: "Tooltip",
  description: "Tooltip primitives re-export and <Kbd> keyboard shortcut badge for tooltip content.",
  contributions: [],
} satisfies PluginDefinition;
```

## Plugin 2: `icon-button`

**Location:** `plugins/primitives/plugins/icon-button/`

### Props

```ts
interface IconButtonProps {
  icon: ComponentType<{ className?: string }>;
  label: string;                            // aria-label + default tooltip text
  tooltip?: ReactNode;                      // override tooltip content
  shortcut?: string;                        // rendered as <Kbd> inside tooltip
  variant?: "ghost" | "secondary" | ...;    // default "ghost"
  size?: "icon" | "icon-sm" | ...;          // default "icon"
  side?: "top" | "right" | "bottom" | "left"; // tooltip position, default "top"
  // ...rest forwarded to Button (onClick, disabled, className, aria-pressed, etc.)
}
```

### `web/components/icon-button.tsx`

```tsx
function IconButton({
  icon: Icon,
  label,
  tooltip,
  shortcut,
  variant = "ghost",
  size = "icon",
  side,
  ...props
}: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant={variant} size={size} aria-label={label} {...props}>
            <Icon className="size-4" />
          </Button>
        }
      />
      <TooltipContent side={side}>
        {tooltip ?? label}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}
```

Imports `Tooltip`, `TooltipTrigger`, `TooltipContent`, `Kbd` from `@plugins/primitives/plugins/tooltip/web` and `Button` from `@/components/ui/button`.

### `web/index.ts`

```ts
export { IconButton, type IconButtonProps } from "./components/icon-button";

export default {
  id: "icon-button",
  name: "Icon Button",
  description: "Ghost icon button with tooltip. Composes Button + Tooltip into a single component.",
  contributions: [],
} satisfies PluginDefinition;
```

## Migration targets

### Full `IconButton` migration (Tooltip+Button -> IconButton)

| File | Notes |
|---|---|
| `plugins/theme/web/components/theme-toggle.tsx` | 2 instances (ThemeToggle + ExperimentalToggle). Dynamic icon/label via ternary. |
| `plugins/screenshot/web/components/screenshot-button.tsx` | Straightforward. |
| `plugins/screenshot/plugins/draw-on-app/web/components/draw-on-app-button.tsx` | Straightforward. |
| `plugins/reorder/plugins/edit-mode/web/internal/pen-button.tsx` | Dynamic variant (ghost/secondary), `aria-pressed`. Both go through `...props`. |

### `PaneIconAction` refactor

`plugins/primitives/plugins/pane/web/components/pane-icon-action.tsx` currently uses `<Button title={label}>` (no tooltip). Refactor to delegate to `<IconButton>` — same external API, proper tooltip for free. Keep the `children` fallback path (no current callers use it, but the type allows it).

### Import-only migration (switch `@/components/ui/tooltip` to `@plugins/primitives/plugins/tooltip/web`)

These use Tooltip with non-button triggers — NOT candidates for `IconButton`:

- `plugins/build/web/components/build-button.tsx` — labeled button, not icon-only
- `plugins/tasks/plugins/task-draft-form/web/components/task-draft-popover.tsx` — wraps PopoverTrigger
- `plugins/worktree-switcher/web/components/worktree-dropdown.tsx` — wraps a `<span>`
- `plugins/health/web/components/health-dot.tsx` — wraps a `<div>`
- `plugins/conversations/.../progress-dots.tsx` — wraps `<span>` elements
- `plugins/conversations/.../allow-monitor-chip.tsx` — wraps native `<button>` with custom styling
- `plugins/conversations/.../fork-conversation-buttons.tsx` — uses children API (no render prop)
- `plugins/apps/web/components/app-rail.tsx` — native `<button>` with fully custom styling, NOT shadcn Button

### NOT migrated

- `web/src/components/ui/sidebar.tsx` — framework component, not plugin code

## Implementation steps

1. Create `plugins/primitives/plugins/tooltip/` (package.json, kbd.tsx, index.ts)
2. Create `plugins/primitives/plugins/icon-button/` (package.json, icon-button.tsx, index.ts)
3. Run `bun install` (new workspaces) + `./equin build` to regenerate plugins.generated.ts
4. Migrate 4 icon-button consumers to `<IconButton>`
5. Refactor `PaneIconAction` to use `<IconButton>` internally
6. Switch raw tooltip imports in 8 files to `@plugins/primitives/plugins/tooltip/web`
7. Run `./equin build` and verify in browser

## Verification

- `./equin build` succeeds
- Toolbar buttons (theme, screenshot, draw, pen) show tooltips on hover after 300ms delay
- Pane action buttons (VSCode, Open app, Expand, etc.) show tooltips instead of native title
- App rail buttons still show `side="right"` tooltips
- Build button still shows its existing tooltip

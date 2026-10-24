# Command Palette Primitive

## Context

There is no unified search-and-act surface in the app. As plugin count grows, users have no way to discover or trigger commands without knowing where they live in the UI. A `Cmd+K` command palette primitive lets plugins contribute commands (title, icon, action, keywords) via a slot, and users fuzzy-search and invoke them from anywhere.

## Design

New plugin at `plugins/primitives/plugins/command-palette/`.

**Slot**: `defineSlot` (non-visual). The palette owns all rendering — fuzzy-match highlighting, keyboard focus management, group headers. `defineRenderSlot` would fight these needs.

**UI**: Built from scratch on `@base-ui/react/dialog` (already used by `sheet.tsx`). No new dependency (`cmdk`, `fuse.js`, etc.).

**Fuzzy matching**: Inline subsequence scorer (~30 lines). Scores consecutive-char and word-boundary bonuses. Returns match ranges for character-level highlighting.

**Global shortcut**: `Core.Root` contribution with a zero-render component that does `window.addEventListener("keydown", ...)` for `Cmd+K`/`Ctrl+K` — same pattern as sidebar toggle (`sidebar.tsx:97-110`) and `EscHandler`.

**Programmatic API**: `defineCommand` for `Open` and `Toggle` — same pattern as `Shell.Toast` and `Improve.OpenWithText`.

## File tree

```
plugins/primitives/plugins/command-palette/
├── package.json
└── web/
    ├── index.ts                         # barrel + PluginDefinition
    ├── slots.ts                         # CommandPalette.Item slot
    ├── commands.ts                      # CommandPaletteCommands.Open / .Toggle
    └── internal/
        ├── command-palette-root.tsx     # Core.Root — keyboard listener + dialog mount
        ├── command-palette-dialog.tsx   # Dialog UI
        └── fuzzy.ts                     # subsequence scorer
```

## Slot shape

```ts
// web/slots.ts
export interface CommandPaletteItem {
  id: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  shortcut?: string;       // display badge, e.g. "⌘B"
  keywords?: string[];     // extra fuzzy-match targets
  group?: string;          // group header label
  onSelect: () => void;
}

export const CommandPalette = {
  Item: defineSlot<CommandPaletteItem>("command-palette.item", {
    docLabel: (p) => p.label,
  }),
};
```

## Commands

```ts
// web/commands.ts
export const CommandPaletteCommands = {
  Open:   defineCommand<{ open: boolean }, void>("command-palette.open"),
  Toggle: defineCommand<undefined, void>("command-palette.toggle"),
};
```

`Open({ open: true })` / `Open({ open: false })` for explicit control. `Toggle(undefined)` to flip. Both handled inside `CommandPaletteRoot`.

## Implementation steps

### 1. `package.json`

```json
{
  "name": "@singularity/plugin-primitives-command-palette",
  "private": true,
  "version": "0.0.1"
}
```

No new deps — `@base-ui/react`, `react`, `react-icons`, Tailwind all come from root.

### 2. `web/internal/fuzzy.ts`

Pure function, no React:

```ts
export interface FuzzyMatch {
  score: number;
  ranges: [start: number, end: number][];  // highlight ranges
}

export function fuzzyMatch(needle: string, haystack: string): FuzzyMatch | null
```

Algorithm: iterate needle chars through haystack. Award bonus for consecutive chars and word boundaries (uppercase, after space/hyphen). Return `null` if any needle char isn't found. `ranges` are collapsed contiguous spans for highlight rendering.

### 3. `web/internal/command-palette-dialog.tsx`

Props: `{ open, onClose, items: CommandPaletteItem[] }`.

Structure (using `@base-ui/react/dialog`):

```
Dialog.Root (open, onOpenChange)
  Dialog.Portal
    Dialog.Backdrop — fixed inset-0 z-50 bg-black/10 backdrop-blur-xs (same as sheet.tsx)
    Dialog.Popup — fixed inset-0 z-50, flex items-start justify-center pt-[20vh]
      Container — w-full max-w-lg rounded-xl border bg-popover shadow-2xl
        Search row — border-b px-3 py-2, MdSearch icon + <input autoFocus>
        Results — ScrollArea max-h-80, grouped items or flat by score
        Footer — border-t px-3 py-1.5, ↑↓ navigate / ↵ select / Esc close (Kbd badges)
```

Internal state:
- `query` — search string
- `activeIdx` — keyboard-highlighted row
- `filtered` — derived via `useMemo`: run `fuzzyMatch(query, item.label)` and also against each keyword, take best score. Sort by score desc when query is non-empty; original order when empty.

Keyboard (`onKeyDown` on the input):
- `ArrowUp/ArrowDown` — move `activeIdx`, wrap at edges
- `Enter` — `filtered[activeIdx].onSelect()`, then `onClose()`
- `Escape` — `onClose()`

Group behavior:
- When query is empty: group by `item.group`, render group headers
- When query is non-empty: flat list sorted by score (groups scatter when sorted)

Each `CommandItem` renders: icon (size-4) | label with highlighted chars (bold the matched spans using `ranges`) | shortcut as `<Kbd>` on the right. Active row has `bg-accent text-accent-foreground`.

### 4. `web/internal/command-palette-root.tsx`

`Core.Root` contribution — the glue:

```tsx
export function CommandPaletteRoot() {
  const [open, setOpen] = useState(false);
  const items = CommandPalette.Item.useContributions();

  CommandPaletteCommands.Open.useHandler(({ open }) => setOpen(open));
  CommandPaletteCommands.Toggle.useHandler(() => setOpen((v) => !v));

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return <CommandPaletteDialog open={open} onClose={() => setOpen(false)} items={items} />;
}
```

### 5. `web/index.ts`

Barrel: default-export the `PluginDefinition`, named-export `CommandPalette`, `CommandPaletteCommands`, and the `CommandPaletteItem` type.

### 6. Seed commands from shell

To make the palette useful immediately, add a few commands from existing plugins. This can be a follow-up, but a minimal set to ship with:

- **Toggle sidebar** — `⌘B`, group "Navigation"
- **Toggle theme** — group "Appearance"

These are contributed from their respective plugins (not hard-coded in the palette). This step is optional for the initial PR — the palette works empty (shows "No commands found") and plugins add commands incrementally.

## Critical files to modify

| File | Action |
|------|--------|
| `plugins/primitives/plugins/command-palette/package.json` | Create |
| `plugins/primitives/plugins/command-palette/web/index.ts` | Create |
| `plugins/primitives/plugins/command-palette/web/slots.ts` | Create |
| `plugins/primitives/plugins/command-palette/web/commands.ts` | Create |
| `plugins/primitives/plugins/command-palette/web/internal/fuzzy.ts` | Create |
| `plugins/primitives/plugins/command-palette/web/internal/command-palette-root.tsx` | Create |
| `plugins/primitives/plugins/command-palette/web/internal/command-palette-dialog.tsx` | Create |

`web/src/plugins.generated.ts` is auto-generated by `./equin build`.

## Existing code to reuse

- `@base-ui/react/dialog` — `Root`, `Portal`, `Backdrop`, `Popup` (see `web/src/components/ui/sheet.tsx` for the pattern)
- `ScrollArea` — `@/components/ui/scroll-area`
- `Kbd` — `@plugins/primitives/plugins/tooltip/web` for shortcut badges
- `cn()` — `@/lib/utils` for conditional classes
- `MdSearch` — `react-icons/md` for the search icon

## Verification

1. `./equin build` — builds and deploys
2. Open `http://<worktree>.localhost:9000`
3. Press `Cmd+K` — palette dialog appears centered with search input focused
4. Type — fuzzy matching filters commands, matched chars highlighted
5. Arrow keys — navigate items, active item highlighted
6. Enter — invokes selected command, palette closes
7. Escape or click backdrop — palette closes
8. Empty query — shows all commands grouped; non-empty query — flat sorted by score
9. Screenshot to verify visual polish

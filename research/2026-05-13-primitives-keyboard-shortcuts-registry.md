# Keyboard Shortcuts Registry

## Context

Each plugin that needs keyboard shortcuts registers its own `window.addEventListener('keydown', ...)` independently. Today there are only 3 global listeners (Escape×2, Cmd+B), but as plugins grow, conflicts and undiscoverability become a real problem. A centralized `defineShortcut()` contribution point is needed — one that detects conflicts, exposes the full shortcut map for discoverability, and provides a single keydown listener.

## Inventory of existing shortcuts

| Location | Keys | Scope | Migrate? |
|---|---|---|---|
| `plugins/reorder/plugins/edit-mode/web/internal/esc-handler.tsx` | Escape | Global, when edit-mode active | **Yes** — module-level store, clean fit |
| `plugins/primitives/plugins/paste-images/web/components/lightbox.tsx` | Escape | While lightbox mounted | **No** — modal-local, receives `onClose` from props |
| `web/src/components/ui/sidebar.tsx` | Cmd+B | Global, always | **No** — `toggleSidebar` lives in React context inside a shadcn component; refactoring sidebar state to module-level is out of scope |

Scoped `onKeyDown` props (rename inputs, diff select-all, tree row a11y, Lexical Enter) are element-local and stay as-is.

## Design

### New plugin: `plugins/primitives/plugins/shortcuts/`

A web-only primitive plugin. No server, no core barrel (types are simple enough to inline or re-export later).

### API

**`Shortcuts.Shortcut`** — a `defineSlot<ShortcutDescriptor>` for static plugin-level shortcuts:

```ts
type ShortcutDescriptor = {
  id: string;              // stable unique ID, e.g. "reorder.exit-edit-mode"
  keys: string;            // key combo string, e.g. "mod+k", "escape", "mod+shift+n"
  label: string;           // human-readable, e.g. "Exit edit mode"
  group?: string;          // category for future palette, e.g. "Navigation"
  handler: () => void;     // action to execute
  when?: () => boolean;    // optional guard — called at event time
  priority?: number;       // higher wins on conflict; default 0
};
```

**`defineShortcut(descriptor)`** — thin wrapper over `Shortcuts.Shortcut(...)` that validates the key combo at dev time. Returns a `Contribution` for the `contributions: [...]` array.

```ts
// Usage in a plugin:
contributions: [
  defineShortcut({
    id: "reorder.exit-edit-mode",
    keys: "escape",
    label: "Exit edit mode",
    group: "Reorder",
    handler: () => setEditMode(false),
    when: () => getEditMode(),
  }),
]
```

**`formatShortcutLabel(keys)`** — pure string formatter for display. `"mod+k"` → `"⌘K"` on Mac, `"Ctrl+K"` elsewhere. Used by `<IconButton shortcut>` and future palette.

### Key combo format

- Split on `+`. Modifiers: `mod` (⌘/Ctrl), `shift`, `alt`/`option`, `ctrl`/`control`, `meta`/`cmd` (alias for mod).
- `mod` maps to `metaKey` on Mac, `ctrlKey` elsewhere. Mac detection via `navigator.userAgent`.
- Aliases: `esc` → `escape`, `return` → `enter`, `del` → `delete`, `space` → ` `.
- Strict matching: all declared modifiers must be present; no extra modifiers may be active.
- Parsed once at registration time → cached `ParsedCombo` object.

### ShortcutManager

A single `Core.Root` contribution. Reads `Shortcuts.Shortcut.useContributions()`, maintains a stable `useRef` for the latest list, and registers one `window.addEventListener('keydown', ...)`.

On each keydown:
1. Filter contributions whose parsed combo matches the event
2. Apply `when()` guards
3. Pick highest `priority` winner (default 0; ties: first contribution wins)
4. If winner found: `e.preventDefault()`, call `handler()`

**Conflict detection** (dev-only): on each contribution-set change, log a console warning when multiple shortcuts share the same key combo without differing `when` guards.

### File structure

```
plugins/primitives/plugins/shortcuts/
├── package.json
├── CLAUDE.md
└── web/
    ├── index.ts                    # barrel + PluginDefinition (Core.Root → ShortcutManager)
    ├── slots.ts                    # Shortcuts.Shortcut defineSlot
    └── internal/
        ├── types.ts                # ShortcutDescriptor, ParsedCombo
        ├── parse-keys.ts           # parseCombo(), matchesEvent(), isMac
        ├── format-keys.ts          # formatShortcutLabel()
        ├── define-shortcut.ts      # defineShortcut() wrapper
        └── shortcut-manager.tsx    # ShortcutManager component
```

### Migration: edit-mode Escape

1. Add `getEditMode()` export to `plugins/reorder/web/internal/edit-mode-store.ts` (one-liner: `return editMode`).
2. Re-export `getEditMode` from `plugins/reorder/web/index.ts`.
3. In `plugins/reorder/plugins/edit-mode/web/index.ts`: replace `Core.Root({ component: EscHandler })` with `defineShortcut({ id: "reorder.exit-edit-mode", keys: "escape", ... when: () => getEditMode() })`.
4. Delete `plugins/reorder/plugins/edit-mode/web/internal/esc-handler.tsx`.

### Integration with `<IconButton shortcut>`

Update `plugins/primitives/plugins/icon-button/web/components/icon-button.tsx` to import `formatShortcutLabel` and format the `shortcut` prop internally. Callers pass `shortcut="mod+b"` (raw combo), the component renders `<Kbd>⌘B</Kbd>`.

### Not in scope (future)

- **`useShortcut()` hook** for dynamic, component-scoped shortcuts (active while mounted). Needed for lightbox Escape, sidebar Cmd+B, and any modal-local shortcuts. The `ShortcutManager` already supports a module-level registry alongside the slot — adding this hook later is additive.
- **Sequence shortcuts** (e.g. `g then i`).
- **User-customizable keybindings** — the registry makes this possible later.
- **Command palette UI** — `Shortcuts.Shortcut.useContributions()` is already the data source.

## Critical files

| File | Action |
|---|---|
| `plugins/primitives/plugins/shortcuts/web/internal/types.ts` | Create |
| `plugins/primitives/plugins/shortcuts/web/internal/parse-keys.ts` | Create |
| `plugins/primitives/plugins/shortcuts/web/internal/format-keys.ts` | Create |
| `plugins/primitives/plugins/shortcuts/web/slots.ts` | Create |
| `plugins/primitives/plugins/shortcuts/web/internal/define-shortcut.ts` | Create |
| `plugins/primitives/plugins/shortcuts/web/internal/shortcut-manager.tsx` | Create |
| `plugins/primitives/plugins/shortcuts/web/index.ts` | Create |
| `plugins/primitives/plugins/shortcuts/package.json` | Create |
| `plugins/reorder/web/internal/edit-mode-store.ts` | Edit — add `getEditMode()` |
| `plugins/reorder/web/index.ts` | Edit — re-export `getEditMode` |
| `plugins/reorder/plugins/edit-mode/web/index.ts` | Edit — replace EscHandler with defineShortcut |
| `plugins/reorder/plugins/edit-mode/web/internal/esc-handler.tsx` | Delete |
| `plugins/primitives/plugins/icon-button/web/components/icon-button.tsx` | Edit — use `formatShortcutLabel` |
| `web/src/plugins.ts` | Edit — register shortcuts plugin |

## Sequencing

1. Create the shortcuts plugin (types → parse-keys → format-keys → slots → define-shortcut → shortcut-manager → barrel)
2. Register in `web/src/plugins.ts`
3. Migrate edit-mode Escape (add `getEditMode`, replace EscHandler with `defineShortcut`)
4. Update `<IconButton>` to format shortcut labels
5. `./equin build` and verify

## Verification

1. `./equin build` succeeds
2. Open the app — enter edit mode (pen button), press Escape → exits edit mode (shortcut fires through registry)
3. Dev console: no conflict warnings with a clean set of shortcuts
4. Hover an IconButton with a `shortcut` prop → tooltip shows platform-formatted label (⌘ on Mac)
5. In browser console: inspect `Shortcuts.Shortcut.useContributions()` equivalent — the registry exposes all active shortcuts

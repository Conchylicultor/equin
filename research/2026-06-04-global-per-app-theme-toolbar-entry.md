# Per-app theme customizer — reachable from every app's action toolbar

## Context

The per-app scoped-config primitive and per-app theming mechanism (fork/diverge/track-base,
app-scoped token groups + `colorMode`, `ColorModeApplier`) are **already implemented and
working** — see `research/2026-06-03-global-per-app-scoped-config.md`. The theme customizer
reads/writes the active app's scope correctly (verified at the endpoint level).

The **only** remaining gap is the UI entry point. The theme-customizer's trigger is contributed
to `Shell.Sidebar`, which is rendered **only by the agent-manager shell**. Every other app
(Forge, Sonata, Debug, Deploy, Workflows, File-explorer, Pages) wires its own private
`*.Sidebar` slot that nobody contributes a Theme entry to. As a result a user cannot open the
theme customizer — and therefore cannot fork/customize the theme — for any app except
agent-manager.

**Goal:** surface the theme-customizer entry point in every app's action toolbar, next to the
reorder (pen) button.

## Key finding: `ActionBar.Item` is the universal cross-app slot

`ActionBar.Item` (`@plugins/shell/plugins/action-bar/web`, slot id `action-bar.item`) is
rendered by **two** surfaces, which together cover every app:

- **`ActionBarStrip`** — contributed to the agent-manager's `Shell.Toolbar`. Covers
  agent-manager.
- **`FloatingBar`** (`plugins/floating-bar/web/components/floating-bar.tsx`) — mounted globally
  at `Core.Root`; renders `<ActionBar.Item.Render />` in every app, hiding itself only when
  `activeApp.hostsToolbar === true` (i.e. on agent-manager, which already shows the strip).

So a **single `ActionBar.Item` contribution** appears in every app with zero per-app changes.
The light/dark `ThemeToggle` (`plugins/theme`) already uses this slot — only the customizer-pane
opener is missing.

### Pane rendering is cross-app (verified — no risk)

`themeCustomizerPane` is registered via `Pane.Register` into the **global** module-level pane
registry (`plugins/primitives/plugins/pane/web/pane.ts`). `<MillerColumns />` is mounted by
every app (via `AppShellLayout`, and directly by Deploy/Sonata's custom layouts), and it reads
that same global registry. Opening `themeCustomizerPane` with `mode: "root"` from any app
re-renders MillerColumns to show the customizer. Opening the pane works identically in every app.

### Ordering next to the pen button (verified)

Reorder sorting (`plugins/reorder/web/internal/sorting.ts`) pushes all
`excludeFromReorder: true` items to the **end**, ordered among themselves by registration
(plugin-load) order. The pen button (`reorder/edit-mode`, id `reorder-pen`) is the only such
item today. Marking the new theme button `excludeFromReorder: true` lands it adjacent to the
pen button and keeps it pinned (un-draggable), matching the pen's behavior. Either side
("next to") satisfies the requirement.

## Implementation

Two files in `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/`.

### 1. New: `web/components/theme-customizer-button.tsx`

Mirror `PenButton` (`plugins/reorder/plugins/edit-mode/web/internal/pen-button.tsx`) byte-for-byte
in shape. Use the pane's `useToggle` (signature confirmed: `(params, opts?) => { isOpen, toggle }`,
`pane.ts:644`). `useToggle` is safe to call outside a pane (no `PaneInstanceContext` → scans the
full chain).

```tsx
import { MdPalette } from "react-icons/md";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { themeCustomizerPane } from "../panes";

export function ThemeCustomizerButton() {
  const { isOpen, toggle } = themeCustomizerPane.useToggle({}, { mode: "root" });
  return (
    <IconButton
      icon={MdPalette}
      label="Theme"
      variant={isOpen ? "secondary" : "ghost"}
      aria-pressed={isOpen}
      onClick={toggle}
    />
  );
}
```

`mode: "root"` matches the current sidebar behavior (clicking Theme replaces the chain with the
customizer).

### 2. Edit: `web/index.ts`

Replace the `Shell.Sidebar` contribution with an `ActionBar.Item`, and drop the now-dead imports
(`MdPalette`, `openPane`, `sidebarNavItem`, `Shell`). Per the user's decision the sidebar entry is
**removed**, not kept — one consistent toolbar entry point everywhere.

```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { themeCustomizerPane } from "./panes";
import { ThemeCustomizerButton } from "./components/theme-customizer-button";

export { ThemeCustomizer } from "./slots";
export { themeCustomizerPane } from "./panes";
export { TokenRow, type TokenRowProps } from "./components/token-row";
export { TokenModeContext, type TokenMode } from "./internal/token-mode-context";

export default {
  name: "Theme Customizer",
  description:
    "Extensible theme customization pane with global preset picker, search, and contributed sections.",
  contributions: [
    Pane.Register({ pane: themeCustomizerPane }),
    ActionBar.Item({
      id: "theme-customizer",
      excludeFromReorder: true,
      component: ThemeCustomizerButton,
    }),
  ],
} satisfies PluginDefinition;
```

Import validity: `@plugins/shell/plugins/action-bar/web` is already imported by `theme`,
`reorder/edit-mode`, `build`, `improve`, `screenshot`, `health`, `notifications` — a standard
path. `@plugins/primitives/plugins/icon-button/web` is used by `PenButton`. Removing the
`Shell.Sidebar` contribution drops the plugin's `shell.Shell` dependency.

### 3. Docs

The theme-customizer `CLAUDE.md` autogen block records
`Contributes: Pane.Register "theme-customizer", Shell.Sidebar "Theme"` and `Uses: ... shell.Shell`.
`./equin build` regenerates these from the contributions, so the new
`ActionBar.Item "theme-customizer" → ThemeCustomizerButton` and the dropped `shell.Shell` edge
update automatically. Run `./equin check` (plugin-boundaries, plugins-doc-in-sync, eslint).

## Critical files

- `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/components/theme-customizer-button.tsx` (new)
- `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/index.ts` (edit)
- Reference: `plugins/reorder/plugins/edit-mode/web/internal/pen-button.tsx` (shape to mirror)
- Reference: `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/panes.tsx` (`themeCustomizerPane`)

## Implementation notes (as built)

Two refinements surfaced during implementation and are part of the shipped change:

1. **Sonata had no pane host → crash.** Sonata uses a bespoke full-viewport layout
   (no `AppShellLayout`/`MillerColumns`), so the pane registry was never synced there and
   clicking the button crashed with *"Unknown pane: theme-customizer."* Fix: a new reusable
   **`PaneOverlayHost`** primitive (`plugins/layouts/plugins/miller/web/components/pane-overlay-host.tsx`,
   exported from the miller barrel). It always syncs the pane registry (so `openPane` never
   throws) and renders `MillerColumns` in an opaque `z-40` overlay only when a pane is open;
   otherwise renders nothing and the app stays interactive. Sonata mounts it inside a
   `relative` container (`sonata-layout.tsx`). Any future custom-layout app can drop it in.

2. **Closing a root pane.** A caller-less open (toolbar/floating bar) always rebuilds a fresh
   chain, so the customizer lands at chain index 0 in every app — and `close()` no-ops at
   index 0. The button therefore closes by navigating to the active app's base path (via
   `useActiveApp().path`), exactly as the app rail does; the pane system re-derives that app's
   default view (welcome for `/`, forge root for `/forge`, empty → Sonata for `/sonata`). This
   makes the button a true toggle that works uniformly across pane-hosting apps and Sonata.

Files added/changed beyond the original plan: `pane-overlay-host.tsx` (new) + miller barrel
export; `sonata-layout.tsx` (mount the host); `theme-customizer-button.tsx` (toggle via
`useActiveApp` navigation instead of `useToggle`'s pane `close`).

## Verification (end-to-end)

1. `./equin build`.
2. **Every app:** open `http://<worktree>.localhost:9000/forge`, `/sonata`, `/debug`, `/deploy`,
   `/workflows`, `/files`, `/pages`. Hover the top-right floating bar → confirm a palette button
   sits next to the pen button. Click it → the theme customizer pane opens in that app.
3. **Agent-manager:** at `/`, confirm the palette button shows in the main toolbar strip next to
   the pen, the sidebar no longer has a "Theme" item, and clicking it opens the customizer.
4. **Per-app customization works through the new entry:** on `/forge`, open the customizer via the
   toolbar button, toggle "Customize for this app", change preset/colorMode → Forge diverges while
   other un-customized apps continue to track base (validates the already-built mechanism is now
   reachable). Un-fork reverts.
5. Scripted: `bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/forge --click "Theme"
   --out /tmp/theme` to confirm the button exists and toggles the pane.
6. `./equin check` passes (plugin-boundaries, plugins-doc-in-sync, eslint).

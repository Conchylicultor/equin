# Per-window theming for portaled UI

## Context

Commit `6e663c5ac feat(theme): per-window theming in desktop multi-window mode`
themes each desktop window's inline content via a `[data-theme-scope="app:<id>"]`
subtree override on the window's frame `<div>` (`window-frame.tsx:105`). The
scoped CSS variable blocks are written to `<head>` by `ScopedAppTheme`
(`plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx`), one per
distinct app id, mounted by `AppWindowsBody`.

But popovers, dialogs, dropdown menus, selects, tooltips, and sheets are all
Base UI components that **portal to `document.body`** by default. They escape the
window's subtree, so they no longer match `[data-theme-scope="app:<id>"]` and
fall back to the global `:root` palette (which tracks whichever window is
focused). The result: a popover opened from a green-themed window renders with
the focused window's (e.g. blue) chrome theme.

The goal is to make portaled UI adopt the theme of the window it was launched
from.

## Key insight — stamp the attribute, don't retarget the portal

Two facts make this far simpler than threading a portal `container` through every
component:

1. **Theme scoping is purely attribute-selector based.** The scoped block is
   `[data-theme-scope="app:<id>"] { --background: …; … }` (plus
   `.dark [data-theme-scope="app:<id>"] { … }`). Any element carrying that
   attribute gets the scoped CSS custom properties, and its descendants inherit
   them through the normal cascade — regardless of where it sits in the DOM.

2. **React context flows through portals along the React tree, not the DOM tree.**
   A Base UI `Portal`'s content is a React child of the component that renders it,
   which lives inside the window's React subtree. So a context provided at the
   window level reaches the portaled content even though the content's DOM parent
   is `document.body`.

Therefore: instead of redirecting the portal to a themed container, we **stamp
`data-theme-scope="app:<id>"` directly onto the portaled content element**, driven
by a React context the window provides. The popup still portals to
`document.body` (positioning, stacking, click-outside behavior all unchanged),
but because it now carries the attribute, the scoped variables apply to it and
its descendants.

This avoids: a container/ref-plumbing API on every component, body-level host-node
lifecycle management, and any floating-ui positioning concerns from a transformed
containing block. It also handles **nested portals** for free (a popover inside a
portaled dialog still sees the same window-level context).

### Why not the `container` approach

The alternative — exposing a `container` prop on each `*Content` and pointing it
at a per-window themed host div — is more invasive (every component grows an API,
plus host-node lifecycle), risks floating-ui positioning issues if the host sits
under the `transform-gpu` backdrop, and would require ui-kit to consume a DOM
node it has no clean way to source. The attribute-stamp approach is strictly
simpler and is recommended.

## Approach

### 1. New context in ui-kit (mechanism)

New file `plugins/primitives/plugins/ui-kit/web/components/portal-theme-scope.tsx`:

```tsx
import { createContext, useContext } from "react";

const PortalThemeScopeContext = createContext<string | undefined>(undefined);

/** Theme-scope token (e.g. "app:home") to stamp on portaled content so it
 *  inherits the originating surface's scoped theme instead of the global :root
 *  chrome theme. Undefined → no attribute → default (global) theme. */
export function usePortalThemeScope(): string | undefined {
  return useContext(PortalThemeScopeContext);
}

export function PortalThemeScopeProvider({
  scope,
  children,
}: {
  scope: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <PortalThemeScopeContext.Provider value={scope}>
      {children}
    </PortalThemeScopeContext.Provider>
  );
}
```

Export `PortalThemeScopeProvider` and `usePortalThemeScope` from the ui-kit
barrel `plugins/primitives/plugins/ui-kit/web/index.ts`.

ui-kit is the lowest layer and has no plugin deps, so the context must live here
(the consuming components can't import a higher plugin without risking an import
cycle). The context's default `undefined` means **zero behavior change** anywhere
a provider isn't mounted (tabs mode, global chrome, command palette, floating
bar).

### 2. Stamp the attribute in the 6 portal components (mechanism)

Each `*Content` reads `usePortalThemeScope()` and stamps `data-theme-scope` on the
**outermost portaled element**. Base UI forwards unknown `data-*` props to the
underlying DOM node.

- `popover.tsx` → `PopoverPrimitive.Positioner` (line 29)
- `dropdown-menu.tsx` → `MenuPrimitive.Positioner` (line 33)
- `select.tsx` → `SelectPrimitive.Positioner` (line 74)
- `tooltip.tsx` → `TooltipPrimitive.Positioner` (line 43)
- `dialog.tsx` → `DialogPrimitive.Popup` (line 43; no Positioner — Portal wraps
  Backdrop + Popup directly)
- `sheet.tsx` → `SheetPrimitive.Popup` (line 51)

Pattern (popover shown; identical shape for the others):

```tsx
function PopoverContent({ … }) {
  const themeScope = usePortalThemeScope();
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        data-theme-scope={themeScope}
        className="isolate z-popover outline-none"
        …
```

Passing `data-theme-scope={undefined}` renders no attribute, so the unscoped
default path is preserved exactly. Stamping the Positioner covers the nested
Popup via inheritance; for dialog/sheet the Popup is the content root (the
Backdrop is a bare scrim and needs no theme vars).

The higher-level wrappers (`InlinePopover`, `WithTooltip`, `CommandPaletteDialog`,
etc.) need **no changes** — they compose these `*Content` components, which now
self-stamp.

### 3. Provide the scope per window (policy — desktop plugin)

In `plugins/apps/plugins/surface-arrangement/plugins/desktop/web/components/window-frame.tsx`,
wrap the existing `<TabSurface tab={tab} />` (line 142) in the provider, reusing
the same scope string already applied to the frame `<div>`:

```tsx
<PortalThemeScopeProvider scope={`app:${tab.appId}`}>
  <TabSurface tab={tab} />
</PortalThemeScopeProvider>
```

This keeps the per-window-theming concern inside the desktop plugin, alongside the
existing `data-theme-scope` frame attribute and `ScopedAppTheme` mount. Tabs mode
mounts no provider, so portals there keep using `:root` (which already equals the
single active app's theme) — correct and unchanged.

Update the `window-frame.tsx` comment (lines 101–104) that currently says
"Portaled descendants escape to document.body and keep the global (focused-app)
chrome theme by design" to reflect that portaled content now adopts the window's
theme via `PortalThemeScopeProvider`.

## Files to change

- **NEW** `plugins/primitives/plugins/ui-kit/web/components/portal-theme-scope.tsx`
- `plugins/primitives/plugins/ui-kit/web/index.ts` — export the provider + hook
- `plugins/primitives/plugins/ui-kit/web/components/ui/popover.tsx`
- `plugins/primitives/plugins/ui-kit/web/components/ui/dropdown-menu.tsx`
- `plugins/primitives/plugins/ui-kit/web/components/ui/select.tsx`
- `plugins/primitives/plugins/ui-kit/web/components/ui/tooltip.tsx`
- `plugins/primitives/plugins/ui-kit/web/components/ui/dialog.tsx`
- `plugins/primitives/plugins/ui-kit/web/components/ui/sheet.tsx`
- `plugins/apps/plugins/surface-arrangement/plugins/desktop/web/components/window-frame.tsx`

> Note: the `ui/*` files carry a "Generated by the shadcn CLI — do not edit by
> hand" convention. The one-line `data-theme-scope` addition is a deliberate,
> minimal exception; it survives re-runs only if re-applied, which is acceptable
> for a one-prop change. Flag in the PR description.

## Out of scope / deferred

- **Toaster + app chrome theme** — the sonner toaster is a single global mount
  (sonner v2.0.7 exposes no portal-container or per-toast theme-scope hook), and
  the desktop backdrop / tab bar likewise have no theme of their own; they
  currently borrow the focused window's `:root` theme. Filed as a separate task
  (`task-1781450321766-io53ex`): give the app chrome (toaster, backdrop, tab bar)
  its own stable, dedicated theme scope instead of tracking the focused window.

- **Raw `createPortal` overlays** — measurement divs
  (`responsive-overflow`, `pane-chrome`, `app-tab-bar`) render nothing visible
  and need no theming. The `lightbox` is a near-black image overlay (theme
  irrelevant). `element-picker` and `draw-on-app` are global toolbar tools
  (global theme is correct). `inline-page-link`'s overlay could later adopt
  `usePortalThemeScope()` if a mismatch is observed, but is out of scope here.

## Verification

1. `./equin build` from the worktree; app at
   `http://att-1781449312-wcl5.localhost:9000`.
2. Switch the surface arrangement to **Desktop** (Settings → Appearance / theme
   customizer, or the Surface-arrangement picker).
3. Open two windows of **different apps** and give them visibly different themes
   (e.g. a distinct preset per app via the per-app theme customizer), so their
   `[data-theme-scope]` palettes differ.
4. From the **non-focused** window, open each portaled surface and confirm it
   renders with **that window's** palette, not the focused window's:
   - a dropdown / select (e.g. a model picker or menu),
   - a popover (e.g. an icon/avatar chooser),
   - a dialog and/or sheet,
   - a tooltip.
   Drive this with `e2e/screenshot.mjs` (`--click` the trigger, capture
   `-after.png`) rather than blind static shots, comparing the popup's
   background/accent against each window's chrome.
5. Confirm **tabs mode** is unchanged: switch back to Tabs, open the same
   surfaces, verify they match the active app theme (no regression).
6. Confirm global chrome (command palette via Cmd+K, floating action bar) still
   uses the global theme (no provider in scope → `:root`).

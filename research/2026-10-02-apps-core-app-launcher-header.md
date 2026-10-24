# App launcher header — one brand header for every app

## Context

Every app hand-rolls the top-left of its sidebar (agent-manager: Equin logo + "Equin" → `/agents`; file-explorer / events / mail: own icon + name, inert; chord: its own `Bar`; pages / debug / studio / settings: nothing). The user wants one standard header, prototyped in `proto-1790939876-0tjb` (grid variant):

- **Launcher icon** (the Equin mark): click → the Home app gallery; hover → a popover with a grid of every installed app's icon (click one to switch). Only the icon triggers this.
- **App name** next to it: click → the *current* app's own homepage (its `basePath`), not the global gallery.
- **Apps without a sidebar**: the launcher icon sits at the leading edge of the first pane header — the same place the sidebar toggle goes today.
- Pages drops its workspace row for the standard header. The app rail stays.

## Design

### 1. `primitives/overlay/plugins/hover-popover` (new primitive)

`<HoverPopover trigger={…} content={…} side align openDelay closeDelay>` — a controlled ui-kit `Popover` opened by hover (after ~120 ms) or keyboard (↓ / focus-within), closed after a ~200 ms grace when the pointer has left **both** trigger and (portaled) content, Esc, or outside press. The trigger's own click is untouched, so "click navigates, hover previews" composes. Touch: first tap opens, second tap clicks.

Why a primitive rather than inline: no existing one fits — `useDisclosureIntent` (`overlay/floating-action/web/internal/use-disclosure-intent.ts`) assumes an in-flow morphing panel under one DOM root, and `InlinePopover` is click-only. Reuse `useDisclosureIntent`'s grace/re-entry logic by lifting it into this plugin's core of a shared timer, rather than copying it.

### 2. `AppShell.Brand` slot (in `primitives/app-shell`)

A single-contribution slot `AppShell.Brand: { component: ComponentType<{ form: "header" | "icon" }> }`, owned by app-shell (which must not import apps-core — it is a primitive; the slot keeps it ignorant of apps). `AppShellLayout`:

- **with a sidebar** — renders `<Brand form="header"/>` as the sidebar header. The `header` prop is **removed** (no app passes one any more; one header for all, by construction).
- **without a sidebar** — `leadingControl` in `SurfaceChromeContext` becomes `<Brand form="icon"/>` (today it is `undefined`), so `PaneChrome` (`primitives/pane/web/components/pane-chrome.tsx:92-110`) draws it at `atSurfaceStart` exactly like the sidebar trigger. With a chrome toolbar and no sidebar, it leads the `<Bar tier="chrome">` instead (same branch that today places the `SidebarTrigger`).
- No contribution → renders nothing (shell still works standalone, like `Framing`).

### 3. `apps-core/plugins/app-launcher` (new, contributes `AppShell.Brand`)

- `AppLauncher` — the Equin mark (`/icon.svg`, as agent-manager uses today) in an icon button wrapped in `HoverPopover`.
  - click → `navigate(defaultApp.app.basePath)`; the gallery target is the `Apps.App` entry flagged `default: true` (Home) — found generically, never named (collection-consumer rule).
  - popover → a 4-column grid over `Apps.App.useContributions()` (minus the default entry), each tile `AppIconView` (`apps-core/plugins/app-icon/web`) + `app.name`, current app (`useActiveApp()`) marked with a dot; click → `replaceTabApp(focusedTabId, id)` / `entry.onClick` exactly as `app-rail.tsx` does (extract that one "activate entry" function from app-rail into apps-core so both call it). Footer: "All apps" → same as icon click. Arrow-key grid navigation.
- `AppHeader` (`form="header"`) — `AppLauncher` + the active app's `name` as a link button → `navigate(active.app.basePath)` (no-op if already there). Name truncates; launcher is rigid.
- `form="icon"` → `AppLauncher` alone.

### 4. App migrations

| App | Change |
|---|---|
| agent-manager, file-explorer, events, mail | delete the `header={…}` block (+ now-unused imports) |
| pages | delete the `workspace` `Pages.Sidebar` contribution and `pages-workspace.tsx` (header becomes standard) |
| debug, studio, settings | nothing — they gain the header for free |
| prototypes, deploy (bare `AppShellLayout`) | nothing — launcher appears in their first pane header for free |
| chord | replace its `Column`+`Bar` header with `<AppShellLayout><FullPane/></AppShellLayout>`; delete `chord-logo.tsx` |
| sonata | wrap its `FullPane` in `AppShellLayout` |
| browser | bespoke chrome bar: put `<AppShell.Brand form="icon">` render at the leading edge of its `Bar tier="chrome"` |
| home | none — it is the gallery the launcher leads to |
| website | none — the public site, not app chrome |

## Critical files

- new `plugins/primitives/plugins/overlay/plugins/hover-popover/web/…`
- `plugins/primitives/plugins/app-shell/web/slots.ts`, `…/components/app-shell-layout.tsx` (Brand slot, drop `header` prop, `leadingControl` for no-sidebar)
- framings `plugins/ui/plugins/sidebar-framing/plugins/{flush,floating,inset}/…` (unchanged contract: still receive `header` via `SidebarFramingProps`)
- new `plugins/apps-core/plugins/app-launcher/web/…`; `plugins/apps-core/plugins/app-rail/web/components/app-rail.tsx` (shared activate function)
- app layouts under `plugins/apps/plugins/<app>/plugins/shell/web/components/`

## Verification

- `./equin build`, then `screenshot.ts` on `/agents`, `/pages`, `/files`, `/prototypes`, `/chord` (light + dark): header present, launcher icon in first pane header on sidebar-less apps.
- e2e `plugins/apps-core/plugins/app-launcher/e2e/launcher.ts`: hover icon → popover with N app tiles; hover name → no popover; click name on a sub-route → app basePath; click icon → Home; click a tile → that app; Esc closes.
- `compare-diff.ts --name proto-1790939876-0tjb --options popover=grid` against `app:/agents`.
- `./equin check` (boundaries, plugins-doc-in-sync, eslint).

# Miller surface-edge chrome: sidebar toggle (left) + floating-bar safe area (right)

## Context

In the agent-manager (and any app that mounts `<MillerColumns/>` with **no app
toolbar**), the miller per-column headers ARE the surface's top chrome. Two
global affordances sit at the surface's top corners and overlap that chrome:

- **Top-right:** the global **floating action bar** (`FloatingActionBarHost`,
  `fixed top-2 right-3 z-popover`) floats *over* the rightmost column header and
  occludes its actions (overflow ⋯ / promote / close).
- **Top-left:** the **sidebar-collapse toggle** has no clean home — today it is
  wedged into the sidebar *header* next to the brand
  (`agent-manager-layout.tsx:20`), plus a vertically-centered
  `SidebarReopenHandle` hack for when the sidebar is collapsed.

The `chrome`-tier `Bar` already solves both for apps that *have* a toolbar: it
bakes in `pr-floating-bar` (clears the floating bar) and `AppShellLayout` injects
the `SidebarTrigger` into it (`app-shell-layout.tsx:100-107`). But the
`pane`-tier `Bar` (the miller column header) does neither, so a no-toolbar miller
app gets nothing.

**Goal:** when the miller columns are the surface's top bar, the **first**
column header hosts the sidebar toggle in a reserved leading slot, and the
**last** column header reserves the floating-action-bar safe area on its right.
No new bar — the existing miller pane toolbar is made compatible. Both
affordances appear **only when miller is the top bar** (i.e. the app has no
`chrome`-tier toolbar above the columns, which already owns these).

User decisions captured: right edge = reserve space for the existing floating
action bar; left edge = the sidebar toggle *lives in* the first column header
(removing the in-sidebar trigger and the reopen-handle hack); both gated on
"miller is the top bar".

## Design — layout-driven surface-edge chrome

Reuse the existing layout→header channel (`PaneLayoutContext`) plus one new
context owned by the app shell. Boundaries stay clean: the **pane** primitive
defines the context, the **app-shell** fills it (it owns the sidebar trigger and
knows whether it rendered a toolbar), **miller** marks first/last, **PaneChrome**
renders. No plugin names another's internals; the floating bar and sidebar
trigger stay owned by their own plugins.

Asymmetry (intentional, matches the ask): the **left** affordance is a *real
button placed in the bar* (the toggle is a flex child); the **right** affordance
is *reserved empty padding* (the floating bar is a separate global overlay we
clear room for).

### 1. `primitives/pane` — new `SurfaceChromeContext` + extend `PaneLayoutContext`

New file `plugins/primitives/plugins/pane/web/surface-chrome-context.ts`,
re-exported from the pane web barrel:

```ts
import { createContext, type ReactNode } from "react";

export interface SurfaceChrome {
  /** True when the content region's top-most pane header IS the surface's top
   *  chrome (no app-shell `chrome`-tier toolbar above it). Gates edge chrome. */
  contentOwnsTopChrome: boolean;
  /** Node mounted in the leading edge of the surface's first top-row header
   *  (e.g. the sidebar toggle). Provider owns it; PaneChrome only renders it. */
  leadingControl?: ReactNode;
}

export const SurfaceChromeContext = createContext<SurfaceChrome>({
  contentOwnsTopChrome: false,
});
```

Extend `PaneLayoutContext` (`plugins/primitives/plugins/pane/web/maximize-context.ts`)
with positional edge flags (purely positional; no app knowledge):

```ts
export const PaneLayoutContext = createContext<{
  onDoubleClickHeader: () => void;
  dragHandleProps?: Record<string, unknown>;
  /** This column is at the surface's start (leftmost) edge. */
  atSurfaceStart?: boolean;
  /** This column is at the surface's end (rightmost) edge. */
  atSurfaceEnd?: boolean;
} | null>(null);
```

### 2. `primitives/bar` — make the floating safe-area a named Bar capability

Today `pr-floating-bar` is hardcoded into the `chrome` tier string. Promote it to
a single-source prop so the `pane` tier can opt in (and we never repeat the
magic class). `plugins/primitives/plugins/bar/web/internal/bar.tsx`:

```ts
export interface BarProps extends HTMLAttributes<HTMLElement> {
  tier?: BarTier;
  overflow?: "hidden" | "visible";
  as?: ElementType;
  /** Reserve the floating-action-bar safe area on the right.
   *  Defaults on for `chrome` (unchanged behavior), off for `pane`. */
  endSafeArea?: boolean;
}

const TIER_CLASS: Record<BarTier, string> = {
  chrome: "h-chrome-bar pl-chrome bg-background", // pr-floating-bar moved to prop
  pane: "h-chrome-pane px-chrome min-w-0",
};

// in Bar(): const safe = endSafeArea ?? tier === "chrome";
// className: cn("flex region-line gap-sm border-b", TIER_CLASS[tier],
//               safe && "pr-floating-bar", overflow === ..., className)
```

`cn` (tailwind-merge) lets `pr-floating-bar` override the `pr` axis of the pane
tier's `px-chrome`. Chrome-tier rendering stays byte-for-byte identical.

### 3. `PaneChrome` — render leading control + reserve right safe-area

`plugins/primitives/plugins/pane/web/components/pane-chrome.tsx`:

```tsx
const { contentOwnsTopChrome, leadingControl } = useContext(SurfaceChromeContext);
const showLeading = contentOwnsTopChrome && layoutCtx?.atSurfaceStart && leadingControl != null;
const reserveEnd  = contentOwnsTopChrome && layoutCtx?.atSurfaceEnd;
```

- Pass `endSafeArea={reserveEnd}` to the `<Bar tier="pane">`.
- Render `{showLeading && leadingControl}` as the **first** child of the Bar,
  before the title. Bar's existing `gap-sm` + `px-chrome` handle spacing — no new
  token needed for the left.

### 4. `layouts/miller` — supply the edge flags

- `MillerColumns` (`miller-columns.tsx:65-91`): pass `isFirst={i === 0}` to
  `<Column>` (already passes `isLast`).
- `Column` (`column.tsx:91`): set the new flags in the provider —
  ```tsx
  <PaneLayoutContext.Provider value={{
    onDoubleClickHeader: toggleMaximize,
    dragHandleProps,
    atSurfaceStart: isFirst,
    atSurfaceEnd: isLast || isMaximized,
  }}>
  ```
  (`isMaximized` so a maximized column — which fills the surface — still clears
  the floating bar.)

Full-pane apps are naturally excluded: `FullPane` sets `PaneLayoutContext` to
`null`, so `atSurfaceStart/End` are undefined → no reservation. Full-pane apps
that need a top bar already use `definePaneToolbar` (chrome tier).

### 5. `primitives/app-shell` — provide the context

`AppShellLayout` (`app-shell-layout.tsx`) wraps its renderer `children`:

```tsx
import { SurfaceChromeContext } from "@plugins/primitives/plugins/pane/web";

const main = (
  <SurfaceChromeContext.Provider value={{
    contentOwnsTopChrome: !toolbarSlot,                       // no chrome toolbar → columns own top
    leadingControl: sidebarSlot ? <SidebarTrigger /> : undefined,
  }}>
    {children}
  </SurfaceChromeContext.Provider>
);
// use {main} in place of {children} inside <main className="...">
```

New dependency edge **app-shell → pane** (pane does not import app-shell → no
cycle). When a toolbar exists, `contentOwnsTopChrome` is false and the existing
toolbar keeps owning the trigger + safe area. When there's no sidebar,
`leadingControl` is undefined (no toggle) but `reserveEnd` still fires (the
floating bar is global).

### 6. `apps/agent-manager/shell` — drop the workarounds

`agent-manager-layout.tsx`:
- Remove `<SidebarTrigger/>` from the sidebar `header` (keep brand only); the
  toggle now lives in the first column header and works whether the sidebar is
  open or collapsed.
- Remove `<SidebarReopenHandle/>` + its wrapper/import; the first-column toggle
  replaces it. Delete the now-unused `sidebar-reopen-handle.tsx`.

## Files to modify

- `plugins/primitives/plugins/pane/web/surface-chrome-context.ts` — **new**.
- `plugins/primitives/plugins/pane/web/index.ts` — export `SurfaceChromeContext` + `SurfaceChrome`.
- `plugins/primitives/plugins/pane/web/maximize-context.ts` — add `atSurfaceStart/atSurfaceEnd`.
- `plugins/primitives/plugins/pane/web/components/pane-chrome.tsx` — leading control + `endSafeArea`.
- `plugins/primitives/plugins/bar/web/internal/bar.tsx` — `endSafeArea` prop, single-source `pr-floating-bar`.
- `plugins/layouts/plugins/miller/web/components/miller-columns.tsx` — pass `isFirst`.
- `plugins/layouts/plugins/miller/web/components/column.tsx` — set edge flags.
- `plugins/primitives/plugins/app-shell/web/components/app-shell-layout.tsx` — provide `SurfaceChromeContext`.
- `plugins/apps/plugins/agent-manager/plugins/shell/web/components/agent-manager-layout.tsx` — drop manual trigger + reopen handle.
- `plugins/apps/plugins/agent-manager/plugins/shell/web/components/sidebar-reopen-handle.tsx` — **delete** (unused).

## Reused, not rebuilt

- `Bar` (`primitives/bar`) and its `pr-floating-bar` token — the right safe area.
- `PaneLayoutContext` (`primitives/pane`) — the existing layout→header channel.
- `SidebarTrigger` (`ui-kit`) — the toggle button, unchanged.

## Known limitations / follow-ups

- If the **first** miller column is *collapsed* (its `CollapsedBar` renders
  instead of `PaneChrome`), the leading toggle is not shown until expanded. In
  the agent-manager the leftmost column (conversation/welcome) is rarely
  collapsed; acceptable. Cmd/Ctrl+B still toggles the sidebar regardless.
- All no-toolbar miller apps with a sidebar gain a consistent first-column-header
  toggle (intended). Verify none currently render their own duplicate trigger.

## Verification

1. `./equin build` from the worktree, then open
   `http://<worktree>.localhost:9000/agents/c/<id>`.
2. **Right edge:** confirm the rightmost column header's actions (⋯ / promote /
   close) are no longer under the floating action bar — there's clearance.
   Compare with a non-last column (no clearance, as expected).
3. **Left edge:** confirm the sidebar toggle sits at the left of the first
   column header; clicking collapses/expands the sidebar. With the sidebar
   collapsed, the same toggle reopens it (no separate reopen handle).
4. **Gating:** open an app that uses a `chrome`-tier toolbar (e.g. a `toolbarSlot`
   app) — its miller columns must NOT show a duplicate toggle or double right
   padding (the toolbar still owns both).
5. **Solo mode:** put the agent-manager tab in solo (fullscreen) placement and
   confirm the floating action bar no longer overlaps the last column header.
6. Scripted check with `e2e/screenshot.mjs` clicking the toggle to assert the
   sidebar `aria` state flips, plus before/after screenshots of the right edge.
7. `./equin check` (boundaries + type-check) passes — especially the new
   app-shell → pane edge and `no-adhoc-bar`.
</content>
</invoke>

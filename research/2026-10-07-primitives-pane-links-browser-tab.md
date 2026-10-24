# Pane links: middle-click opens a browser tab, on every navigating control

## Context

Middle-clicking the pane chrome's **Open in <App>** / **Expand pane** button opens a new
*equin* tab (in-app, `navigate(url, { newTab: true })`). The user wants it to open a new
**browser (Chrome) tab** — and wants that for every button that opens a pane, without callers
building URLs.

Today:

- Link gestures are opt-in: `linkGestureProps(open)` (`primitives/link-gesture`) hands `open`
  `{ newTab }` and each caller decides what "new tab" means. Only 5 components use it
  (pane-chrome, pane-resolve-guard, app-brand, app-launcher via `appLinkProps`, version-list,
  open-app-button).
- ~165 `openPane(...)` calls are bare callbacks. A middle-click fires `onAuxClick`, never
  `onClick`, so no change inside `openPane` alone can see it — the control has to know it
  navigates.
- ⌘/Ctrl-click and middle-click both mean "in-app tab" today.

Decided with the user:

- **Plain click** = today's `openPane` (unchanged).
- **Middle-click and ⌘/Ctrl-click** = new browser tab at the URL of the route the plain click
  *would* produce (browser convention). A new equin tab is only reachable from explicit
  menu entries (e.g. Prototypes' existing "Open in a new app tab").
- No new top-level concept: `openPane` gains a `.link(...)` form with **the same arguments**.
  The imperative call stays for callbacks (onSelect, post-mutation, effects).
- `hint` is ephemeral by design (`{}` on any rebuilt route) — losing it in a new tab is fine.
  `options` are not in URLs; the one production caller passing options (Studio graph
  `focusId`) moves it to a URL param.

## API, before → after

```tsx
// before
const openPane = useOpenPane();
<Button onClick={() => openPane(traceDetailPane, { id }, { mode: "push" })}>Open trace</Button>

// after — same arguments, gestures included
<Button {...openPane.link(traceDetailPane, { id }, { mode: "push" })}>Open trace</Button>

// callbacks: unchanged
onSelect={(id) => openPane(reportDetailPane, { reportId: id }, { mode: "push" })}
```

## Design

### 1. `link-gesture`: "elsewhere" is a browser tab, implemented once

`plugins/primitives/plugins/link-gesture/web/internal/link-gesture.ts`

- New primary form `linkProps({ open, href })`:
  - plain click → `open()`
  - ⌘/Ctrl-click, middle-click → `openInBrowserTab(href())`
  - `href` is a thunk, evaluated **synchronously in the click handler** (so `window.open` is
    still a user-gesture and not popup-blocked, and push/swap is computed against the route at
    click time).
- `openInBrowserTab(path)` = `window.open(new URL(path, location.origin), "_blank", "noopener")`
  — the one place this is spelled (today it's hand-rolled in `frame-link.tsx`,
  `screenshot-button.tsx`, open-app).
- The existing `linkGestureProps(open: ({ newTab }) => void)` stays as the low-level form,
  renamed param `{ elsewhere }`, for the one caller whose "elsewhere" is not a browser tab
  (`open-app-button.tsx`, which flips a configured default between browser tab and framed
  pane). Doc comment: prefer `linkProps`.
- Update the doc comment (gesture table), `CLAUDE.md`.

### 2. Pane primitive: pure route computation + `openPane.link`

`plugins/primitives/plugins/pane/web/pane.ts`

- Extract the route math out of `useOpenPane` (P:2852-2967) and `store.openPaneImpl`
  (P:971-1035) into one pure function, reusing the existing pure helpers
  (`relativeHead`, `chainSlots`, `prefixHosts`, `extractOwnParams`, `sameParams`, `sameOptions`):

  ```ts
  computeOpen(currentRoute, callerInstanceId, target, params, opts)
    → { route: PaneSlot[]; replace: boolean; changed: boolean }
  ```

  `useOpenPane`'s apply path and `openPaneImpl` both become `computeOpen` + `setRoute` (skip
  when `!changed`), so the URL a link builds cannot drift from what a click does. `promote`
  (P:1056) builds on it too.
- `useOpenPane()` returns `OpenPaneFn & { link(target, params, opts): LinkGestureProps }`
  (stable via `useMemo`). `link` = `linkProps({ open: () => fn(...), href: () =>
  routeHref(store, computeOpen(store.getRoute(), …).route) })`. When `changed` is false (target
  already shown) the href is the current route — the destination is on screen.
- `routeHref(store, route)` = `store.getBasePath()` + `buildRouteUrl(route)` (special-case
  `"/"`, mirroring the closed-over `applyBasePath` P:727 — reuse it by exporting it as a store
  method rather than duplicating). For a pane hosted away from home (e.g. a prototype pane in
  the agent-manager surface), this is the *surface's* app basePath + its whole route — i.e.
  the browser tab reproduces exactly the layout the plain click would show.
- `PromoteAction` (P:1870-1883): replace `run(opts?: { newTab })` with `{ run(): void;
  href(): string }`. Cross-app: `href` = the `crossAppUrl` already computed. Re-root: `href` =
  `routeHref(store, computeOpen(…root, fullParams, options).route)` — "Expand pane" gets a URL
  for the first time.
- `pane-chrome.tsx:151` and `pane-resolve-guard.tsx:166` spread `linkProps(promote)`.

### 3. In-app new-tab callers

- `appLinkProps(url)` (`apps-core/tabs/web/internal/app-link.ts`) → `linkProps({ open: () =>
  navigate(url), href: () => url })`; rewrite its doc comment (the "never a browser tab"
  rationale is reversed by this decision). Callers: app-launcher, app-brand (keeps its
  "already home" skip), version-list.
- `navigate(url, { newTab: true })` keeps its in-app meaning for explicit menu entries only.

### 4. Controls must forward the gesture handlers

`linkProps` returns `{ onClick, onAuxClick, onMouseDown }`. `Button`, `IconButton`,
`PaneIconAction` already pass them through. Fix the gaps:

- `IconButton`'s overflow "row" form (`PanelActionRow`, `icon-button.tsx:85`) forwards only
  `onClick` → middle-click is inert in the `⋯` panel. Forward `onAuxClick` / `onMouseDown`.
- Verify per component during migration: `LinkChip`, `Row`, `Card`, `WebsiteNavLink`,
  `SidebarNavRow`, `Text`/`Stack` used as click targets. A component that drops them gets a
  passthrough fix, not a call-site workaround.

### 5. Sidebar nav entries: data, not callbacks

~35 `AppShell` sidebar contributions (`DebugApp.Sidebar`, Studio, Settings, Events, …) are
`onClick: () => openPane(xPane, {}, { mode: "root" })`. `AppShellSidebarNav` already has an
`opens: { pane, params }` arm (`primitives/app-shell/web/components/sidebar-nav-item.tsx`),
which also gives the active highlight. Migrate them all to `opens:`, and have
`SidebarNavOpensItem` render with `openPane.link(target.pane, target.params, { mode: "root" })`.
Example: `plugins/debug/plugins/reports/web/index.ts:19`.

### 6. Studio graph `focusId` → URL param

`plugins/apps/plugins/studio/plugins/graph/web/panes.tsx`: segment `graph` → `graph/:focusId?`,
drop the `options`, read via `useParams`. Update `membership-band.tsx:105` to pass it as a
param and use `.link`. After this no production caller passes `options` through a link.

### 7. Lint rule: `pane/no-onclick-open-pane`

`plugins/primitives/plugins/pane/lint/no-onclick-open-pane.ts` (+ test, registered in the
existing `pane/lint/index.ts`; template: `apps-core/lint/no-raw-history-nav.ts`,
`data-view/lint/no-adhoc-row-list.ts`).

- Reports a JSX `onClick` attribute (and an object property `onClick:`) whose value is a
  function whose body is, or whose block's sole statement is, a call to `openPane` / `*.openPane`.
  Message: spread `openPane.link(...)` instead (or `opens:` for sidebar entries).
- Handlers that do other work (e.g. `attempt-chip.tsx:65` toggles an inline opener when a
  conversation exists) are not "sole statement", so not flagged — migrate those by hand where
  the open is the only navigation (e.g. `e.stopPropagation()` + open → `.link` plus
  `onClickCapture`/wrapper as appropriate), otherwise leave them.

### 8. Migration of call sites

Audit (non-test): ~39 inline JSX `onClick={() => openPane(...)}`, ~12 named handlers passed to
`onClick`, ~35 sidebar entries, ~40 non-click callbacks, ~25 async/helper. Migrate the first
three groups; leave callbacks and async opens imperative. Representative paths:
`active-data/plugins/task-link/web/components/task-link-chip.tsx`,
`conversations/.../jsonl-viewer/plugins/file-path/web/components/file-path.tsx`,
`stats/plugins/cost/web/components/top-conversations-table.tsx`,
`integrations/plugins/google-maps/web/components/maps-access-action.tsx`,
`debug/plugins/timeline/web/components/detail-strip.tsx`.

Wrapper hooks used from clickable controls (`useConversationOpener`, `useOpenSong`,
`useFileOpen`, `useOpenConfig`, …) gain a `.link` sibling only where a call site needs it —
not pre-emptively.

## Out of scope / follow-ups

- **DataView rows**: activation is a bare `() => void` (`data-view-body.tsx:316`), so rows can't
  see modifiers. Follow-up: a per-row `rowLink(row)` alternative to `rowActivation` that views
  wire through `linkProps`. File as a task.
- Rendering links as real `<a href>` (hover URL preview, "Copy link address"): `Button` has no
  `render`/`asChild`; separate change.

## Verification

- Unit: `computeOpen` cases (root / push right / push left incl. already-ancestor / swap no-op /
  no caller / caller not in route / promote) asserting the route equals what the store ends up
  with after the click — `./equin test plugins/primitives/plugins/pane`.
- Lint rule test (valid/invalid fixtures) — `./equin test plugins/primitives/plugins/pane`.
- `./equin check` (type-check incl. the new rule over the whole repo = no remaining
  violations).
- E2E: extend `plugins/primitives/plugins/pane/e2e/expand-verify.ts` (`newTabGestures`):
  middle-click and ⌘-click on Open in <App> / Expand pane / a migrated `Button` and a sidebar
  entry → a new browser `page` event (Playwright `context.waitForEvent("page")`) whose URL
  cold-boots to the expected route, and the original tab's route is unchanged; plain click
  unchanged. Include the `⋯` overflow row case.
- Manual: `./equin build`, then middle-click the Prototypes "Open in Prototypes" button
  from a conversation pane.

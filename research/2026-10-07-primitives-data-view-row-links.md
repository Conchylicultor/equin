# DataView rows as links: middle-click / ⌘-click opens a browser tab

## Context

`openPane.link(...)` (research/2026-10-07-primitives-pane-links-browser-tab.md) gave every
pane-opening *control* the browser's link gestures: plain click opens the pane, ⌘/Ctrl- and
middle-click open the would-be route's URL in a new browser tab. That plan left DataView rows
out of scope: row activation is a bare `() => void` all the way down
(`DataViewProps.onRowActivate` / `rowActivation` → `DataViewRenderProps.rowActivation`,
resolved in `data-view-body.tsx:322`), so the list / table / gallery / icons / tree views never
see the gesture. A middle-click on a row that opens a pane does nothing; a ⌘-click opens it
in place. ~20 of the 37 `onRowActivate`/`rowActivation` call sites open a pane.

Goal: a row that opens a pane is a link, by the same one primitive, with no per-view or
per-call-site gesture code.

## Key constraint: activation is not only a click

A view also activates rows **without a mouse event**: Enter/Space on a focused row
(`DataTable`, `DataCard`, icons tile, tree keyboard), and the tree's deferred activation of a
just-created row (`tree-view.tsx:586`, `activateById`). So the row-level unit cannot be
`LinkGestureProps` (event handlers) — it must be **data**: `{ open, href }`, from which a
mouse-driven element derives gesture handlers and everything else calls `open()`.
`PromoteAction` already has exactly this shape.

## Design

### 1. `link-gesture`: name the data form

`plugins/primitives/plugins/link-gesture/web/internal/link-gesture.ts`

- Export `interface LinkTarget { open(): void; href(): string }` — the argument `linkProps`
  already takes (retype `linkProps(target: LinkTarget)`).
- Export `type Activation = (() => void) | LinkTarget` and
  `activationProps(a: Activation | undefined): { onClick?; onAuxClick?; onMouseDown? }` —
  a bare action gives `{ onClick: a }` (unchanged behaviour), a target gives `linkProps(a)`,
  `undefined` gives `{}` (so `Row` still infers a plain container — the "undefined and all"
  rule holds by construction), plus `runActivation(a)` for the keyboard / programmatic path.
  These are the only places the union is switched on.

### 2. Pane: `openPane.to(...)` — the data form of `.link`

`plugins/primitives/plugins/pane/web/pane.ts` (`useOpenPane`, P:3041)

- `OpenPaneFn.to(target, params, opts): LinkTarget` — same arguments as the call; `open` and
  `href` are the closures `link` builds today. `link` becomes `linkProps(to(...))`, so the two
  cannot drift. `PromoteAction` arms become `LinkTarget & { kind… }`.

### 3. DataView: activation may be a link

Consumer API (`data-view/core/internal/types.ts`):

- `rowActivation?: (row) => Activation | undefined` — the resolver may return a link.
  `onRowActivate?: (row) => void` stays as-is (the every-row action case). No third prop:
  "does this row activate, and how" stays one fact.

  ```tsx
  // before
  onRowActivate={(r) => openPane(traceDetailPane, { id: r.id }, { mode: "push" })}
  // after
  rowActivation={(r) => openPane.to(traceDetailPane, { id: r.id }, { mode: "push" })}
  ```

- Render props: `DataViewRenderProps.rowActivation: (row) => Activation | undefined`;
  `data-view-body.tsx` folds `onRowActivate` into it as today. Update both doc comments and the
  "Row activation is PER ROW" section of `data-view/CLAUDE.md` (views spread
  `activationProps(...)`, never wrap).

### 4. Views and the primitives under them

Each element that takes a click spreads `activationProps(act)`; each keyboard / programmatic
path calls `runActivation(act)`.

- **list** (`list-view.tsx:278,347`): `Row` already forwards `onAuxClick`/`onMouseDown`
  (`css/row/web/internal/row.tsx:54`) — spread. The `TreeRowChrome` arm (`onSelect`) — see tree.
- **gallery** (`data-card.tsx`): `onActivate?: Activation`; card `onClick`/aux from
  `activationProps`, Enter/Space → `runActivation`. Verify `Card` forwards aux/mouseDown
  (fix there if not).
- **icons** (`icons-view.tsx:256`): spread on the tile `Stack`; its keyboard path runs it.
- **table** (`table-view.tsx:223`): `DataTable` is table-level. Add
  `DataTableProps.rowHref?: (row) => string | undefined` (evaluated at click time) beside
  `onRowClick`; the row element uses `linkGestureProps` — elsewhere + href ⇒
  `openInBrowserTab`, else `onRowClick(row)` (keeping the double-click `detail > 1` guard).
  `table-view` maps `act` to `onRowClick = runActivation`, `rowHref = act.href?.()`.
- **tree** (`tree-view.tsx`, `primitives/tree`): `TreeRowChrome` gains an optional
  `selectHref?: () => string`; its row click goes through `linkGestureProps` when present
  (the chevron's stopPropagation and the `onOpen`/`clickOpens` double-click logic unchanged).
  `TreeList` takes `hrefOf?: (id) => string | undefined` and passes it down. `tree-view`
  derives it from `rowActivation(original)`; `activateById` (keyboard + pending-create) calls
  `runActivation`. Expand-on-activate folder rows are untouched (they don't navigate).

### 5. Runs arms

`plugins/runs/web/internal/slots.ts`: `Runs.Kind.open(run, { openPane })` returns
`LinkTarget` (arms use `openPane.to`). `runs-data-view.tsx:121` composes the host's own
`onRowActivate` side effect into `open` and keeps `href` — so build/release/deploy rows in
every runs list become links.

### 6. Lint

Extend `pane/no-onclick-open-pane` (`plugins/primitives/plugins/pane/lint/`) to also flag an
`onRowActivate` (and `rowActivation` returning a closure) whose sole statement is an
`openPane(...)` call → "return `openPane.to(...)` from `rowActivation`". Add fixtures.

### 7. Migrate call sites

Every row that only opens a pane, e.g. `debug/plugins/trace/.../events-view.tsx`,
`debug/plugins/boot-profile/.../boot-profile-list.tsx`,
`apps/plugins/deploy/plugins/deployments/.../deployments-section.tsx`,
`apps/plugins/pages/plugins/page-tree/.../pages-sidebar.tsx` (tree),
`studio/.../release-history-section.tsx`, `conversations/plugins/all-conversations/web/panes.tsx`,
`apps/plugins/mail/plugins/threads/web/panes.tsx`, `prototypes/.../prototype-gallery.tsx`,
`servers-list.tsx`, `sources-list.tsx`, `runs-section.tsx`, `automation-history.tsx`,
`op-status-banner.tsx`, `agents-list.tsx` (conditional open ⇒ per-row target).
Rows whose activation is not a plain pane open (`backlinks.tsx` `nav.open`, `song-library`
`openSong`, `places-sidebar` `openFolder`, selection/toggle rows) stay actions; wrapper
openers gain a `.to` sibling only where a row needs it.

## Out of scope

- Real `<a href>` rows (hover URL, "Copy link address") — same follow-up as the pane plan.
- `onRowOpen` (double-click / Enter) stays an action: it's the "descend" gesture, not a link.

## Verification

- Unit (`./equin test plugins/primitives/plugins/link-gesture plugins/primitives/plugins/data-view plugins/primitives/plugins/data-table plugins/primitives/plugins/tree`):
  `activationProps` arms; per view, a jsdom test that a link row's plain click calls `open`,
  ⌘-click and middle-click call `window.open` with `href()` and not `open`, Enter calls
  `open`, and a non-activating row is still a plain container (extend
  `list/web/__tests__/row-activation.test.tsx`).
- Lint fixtures: `./equin test plugins/primitives/plugins/pane`.
- `./equin check` (type-check + the extended lint rule repo-wide).
- E2E: extend `plugins/primitives/plugins/pane/e2e/expand-verify.ts` (or a data-view e2e):
  middle-click and ⌘-click a row in Debug → Traces (list), a table-view row, and a Pages
  sidebar tree row → `context.waitForEvent("page")` at the expected route URL, original tab
  unchanged; plain click opens the pane as before.

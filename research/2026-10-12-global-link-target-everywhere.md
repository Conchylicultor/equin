# Link targets everywhere — every navigating control honours ⌘/middle-click

**Problem.** Middle-click / ⌘-click opens a browser tab only on controls that
spread `linkProps` / `activationProps` (`primitives/link-gesture`). Every seam
that returns `void` or takes a bare callback (`onClick`, `onNavigate`, `useOpen`
→ `(id) => void`) silently drops the gesture for all its consumers. The pane
lint `no-onclick-open-pane` only sees `onClick={() => openPane(…)}`, so opens
laundered through another prop, through `navigate(…)`, after
`e.stopPropagation()`, or through a named handler all escape it.

**Principle.** An opener returns a `LinkTarget` (data: `open()` + `href()`),
never `void`. A control that navigates takes an `Activation`, never a callback.
Ladder: inexpressible (rename/replace the void APIs) > type error (LinkChip
`onClick?: never`) > lint (the backstop for ad-hoc handlers).

Already landed: `Breadcrumb` — `BreadcrumbSegment.activation` replaces the
trail's `onNavigate`; page-breadcrumb passes `openPane.to(…)`.

## Step 0 — shared API (additive, lands first)

- `link-gesture`: `activationProps(a, opts?: { isolate?: boolean })` — `isolate`
  stops propagation of click + auxclick (not mousedown: editor drag/selection
  need it). The one answer for chips inside clickable rows or Lexical.
- `apps-core/tabs`: `appLink(url): LinkTarget` = `{ open: () => navigate(url),
  href: () => url }`; `appLinkProps(url)` = `linkProps(appLink(url))`.
- `LinkChip`: `activation?: Activation`, spread with `{ isolate: true }`;
  `onClick` deprecated (removed in W6).

## Seam signatures

| Seam | New shape |
|---|---|
| `IdPresenter` | `useTarget: Hook<() => (id) => LinkTarget>` replaces `useOpen` |
| `ConversationOpener` | `toggle(convId): LinkTarget`, `asPage(convId): LinkTarget` |
| page-tree | `useBlockTargetLink(): (t) => LinkTarget` replaces `useOpenBlockTarget` |
| `ArtifactRow` | `activation?: Activation` replaces `onOpen` (`afterOpen(activation, close)`) |
| `PageNavigation` | `open` / `openAside?` / `openBlock?` return `LinkTarget` |
| file-links | `FileLinkText.fileTarget?: (path, line?) => Activation`; `linkifyChildren(children, fileTarget?)`; `useFileTarget()` |
| file explorer | `ExplorerNavigator.to(dir, open?)`, `fileTo(path)` → `Activation`; `useExplorerFolderTarget()` |
| `PathBar` | `activationFor: (t: PathTarget) => Activation` replaces `onNavigate` |
| `CommitRowItem` | `commitActivation?: (c) => Activation` replaces `onClick` |
| `GraphCanvas` | `nodeActivation?: (id) => Activation \| undefined` replaces `onNodeClick` (container aux-click resolves `.react-flow__node` `data-id`) |
| `DataTable` | `rowActivation?: (row) => Activation \| undefined` replaces `onRowClick` + `rowHref` |
| `Contributions.RowClick` | becomes `Contributions.RowActivation` (`rowActivation(row, { openPane }) => Activation`) |
| config-link | `useConfigLink(): (descriptor) => LinkTarget` replaces `useOpenConfig` |

## Workstreams (disjoint file ownership; W1–W5 run in parallel after Step 0)

- **W1 — ids, active-data chips, conversation openers, artifacts.** ids slots,
  id-chip, the nine presenters (event-source, report, build-run, prototype,
  song, task-link, page-link, attempt, conv), task-card, commit-link-chip,
  active-data plugin-link-chip, `use-conversation-opener.ts` (+ its pane test),
  conversation-chip / conversation-row, task-events, page-tree `block-target.ts`
  + barrel, artifacts row/section and prototype/research/page/skill sections.
- **W2 — page editor references.** page-reference navigation/actions/slots,
  page-tree `panes.tsx` provider + backlinks section, sub-page-block,
  page-link-block, page-link-inline-node, inline-page-link chip, links
  backlinks, open-aside-action, open-as-page-item, prompt-origin section.
- **W3 — files.** primitives/file-links, markdown-extensions file opener +
  enhancers (+ inline-text-walker test), jsonl-viewer file-path, file-explorer
  navigator/panes/file-browser/file-tree, places sidebar, path-bar (+ test),
  plugin-view file-tree-section, conv-explorer-body, file-peek-pane.
- **W4 — row/node/table primitives.** commit-list + its consumers, graph-canvas
  + task-graph + studio graph-view, data-table + its consumers (analytics
  filters/chart picks stay plain functions), contributions-table slot + its
  contributors + plugin-chip, metrics breakdown-card / drill-drawer,
  top-conversations-table, profiling op-click / gantt, runs-data-view.
- **W5 — standalone controls.** `navigate(…)` sites (report-detail,
  stranded-config-notice, open-queue-action, build-button, worktree-actions,
  notifications-panel, apps-layout, quick-theme-button), config-link + its
  consumers, debug trace LinkChips, deploy/studio link sites, plugin-view
  plugin-link, tool-call views (page-ref, add-task, bash, skill, agent,
  workflow), attempt-pane, op-status-banner, task-dependencies relations, debug
  queue panes, pages-search, auth default-provider-row.
- **W6 — type tightening + lint (last).** LinkChip `onClick?: never;
  onAuxClick?: never`. Replace `pane/no-onclick-open-pane` with
  `link-gesture/no-click-navigate` (closed):
  - *navigating call*: `openPane(…)` / `x.openPane(…)`; tabs `navigate(…)`
    (not `{ newTab: true }`); a call on a binding from `useOpenPane()`,
    `useOpen*()`, `use*Opener()`; `<call>.open()` with no args.
  - *only navigates*: expression body, or zero+ `stopPropagation` /
    `preventDefault` statements then exactly one navigating call; `void <call>`.
  - *fires on*: `onClick`, `onRowClick`, `onRowActivate`, `onNodeClick`,
    `onOpen`, `onActivate`, `onNavigate`, `onOpenFile`, `onFileOpen` (JSX attrs
    and object props), resolvers `rowActivation` / `nodeActivation` /
    `commitActivation` / `activation` returning `() => <navigating call>`, and
    same-file named handlers (`const` arrow, `function`, `useCallback`).
  - *not flagged*: `onSelect`, `onCreated` / `onSuccess`, handlers doing other
    work, the browser app's own `navigate`.

## Excluded (not links)

Form submits, post-mutation opens (`onCreated`, launch flows), tab management,
the browser app's internal `navigate`, keyboard-only shortcuts.

## Boundaries

All new imports are web → core/web (link-gesture, tabs) — allowed. `appLink`
is exported from tabs' own barrel; no re-exports of link-gesture. Barrels stay
pure. No package.json changes. If `primitives/metrics` may not import
apps-core/tabs, callers pass the `LinkTarget` in.

## Verification

`./singularity test` on data-table, path-bar, filter-rules,
inline-text-walker, open-pane-global-chrome and the lint test; then
middle/⌘-click in the app: id chip, conv chip, page link, file chip, commit
row, task-graph node, contributions row, config gear, page breadcrumb.

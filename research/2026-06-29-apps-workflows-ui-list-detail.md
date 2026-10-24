# Workflows app — list+detail UI over the existing engine

## Context

The Workflows app (`plugins/apps/plugins/workflows/`) has a **complete backend** — DB tables for
definitions/executions/steps, a durable `workflows.run` job, full CRUD HTTP API, two live-state
push resources, a `Workflows.StepType` pluggable slot — but a **dead UI**. Its shell registers the
app and provisions `WorkflowsApp.Sidebar` + `WorkflowsApp.Toolbar` render slots and a
`<MillerColumns/>` main area, yet **zero plugins contribute to those slots**, so a user opening
`/workflows` sees an empty screen. Nothing can list, create, open, or inspect a workflow or its
execution history.

This plan brings the app to parity with the platform's other list+detail apps (Pages, Deploy) by
adding the missing UI sub-plugins. No backend changes. The shell already provisions a real sidebar
slot, so the **Pages** pattern (sidebar list → index pane → detail pane with an extensible
`*.Section` slot) is the reference, not Deploy (no sidebar).

## Design

Two new sub-plugins under `plugins/apps/plugins/workflows/plugins/`:

- **`definitions`** — the sidebar list of workflow definitions, the welcome/index pane, and the
  definition-detail pane (editable name/description, read-only step list, host for an extensible
  `WorkflowsDetail.Section` slot). Create / rename / delete a definition.
- **`executions`** — contributes an **Executions** section into `WorkflowsDetail.Section` (a list of
  the definition's runs + a **Run** button) and owns the execution-detail pane that renders the
  per-step trace. Reuses the existing `Workflows.StepType` slot's `executionComponent` (currently
  unused) for pluggable per-step rendering, with a generic JSON fallback.

The split (rather than one `browse` plugin) is deliberate: it makes `WorkflowsDetail.Section` a
genuine extension point — `executions` plugs into it exactly like `apps/pages/{history,starred,
welcome}` plug into `PageDetail.Section` — matching the project's modularity guidance ("even
mandatory sections become their own plugin").

### Confirmed API facts (from reference code)

- **Reading the StepType slot** (`engine/web/slots.ts:6` is a `defineSlot`, a *data* slot): read with
  `Workflows.StepType.useContributions()`. Only a field literally named `component` is sealed by the
  slot runtime — `icon` / `configComponent` / `executionComponent` come back as **raw
  `ComponentType` and render directly**. Build a `Map<pluginId, contribution>` to look up icon /
  `executionComponent` by `step.stepPluginId`. Wrap each per-step render in `PluginErrorBoundary`
  (`@plugins/primitives/plugins/error-boundary/web`) so one broken step component can't crash the pane.
- **`WorkflowsDetail.Section`** mirrors `Deploy.Section` verbatim
  (`deploy/shell/web/slots.ts:4`): `defineRenderSlot<{ title: string; order: number; component:
  ComponentType<{ definitionId: string }> }>("workflows.detail.section", { docLabel: p => p.title })`.
  Consume via `<WorkflowsDetail.Section.Render>{(s) => …<s.component definitionId={…}/>}</…>`
  (pattern at `servers/web/panes.tsx:98`). `executions` importing `WorkflowsDetail` from the
  `definitions` web barrel is the sanctioned slot-owner import (no re-export).
- **Pane defs** mirror `servers/web/panes.tsx`: `definitionsRootPane` (`segment:""`,
  `appPath: workflowsApp.basePath`, index pane), `definitionDetailPane`
  (`segment:"def/:definitionId"`, `defaultAncestors:[definitionsRootPane]`, `resolve` from
  `workflowDefinitionsDescriptor`), `executionDetailPane` (`segment:"exec/:executionId"`,
  `defaultAncestors:[definitionsRootPane]`, `resolve` from `workflowExecutionsDescriptor`). Flat
  `exec/:executionId` is the simplest correct routing; a richer Definition→Execution breadcrumb is a
  follow-up.
- **DataView**: each `defineDataView("id")` call must live in the *consuming* plugin's `web/**`
  (codegen scrapes the literal id → maps to that plugin's config path). Inline-editable primary
  field via `FieldDef.onEdit` works in flat lists (`pages-sidebar.tsx:87`). Never import a view
  child — select via `views={["list"]}`.
- **Status badges** are executions-local components modeled on `server-status-badge.tsx` (`StatusDot
  colorClass` + `Text caption`).

### MVP scope for create/run

The only existing step type is `branch`, whose executor reads prior-step output, emits no output of
its own, has no `executionComponent`, and needs `nextStepMapping` to route — so **no meaningful
multi-step run is achievable today**. The run-job completes immediately when `entryStepId` is null.
So the create/run MVP is: **create an empty (stepless) definition → Run → an immediately-completed
execution**. This fully exercises the definitions list, detail pane, executions list, status badge,
timing, and the (empty) step-trace fallback end-to-end. A trivial demonstrable step type is the
unlock for a non-empty trace — filed as a follow-up.

## Files

### Plugin A — `plugins/apps/plugins/workflows/plugins/definitions/`
- `package.json` — `@singularity/plugin-apps-workflows-definitions`, `private`, `version 0.0.1`.
- `web/slots.ts` — defines + exports `WorkflowsDetail` (`Section` render slot, see above).
- `web/internal/use-step-type-index.ts` — `useStepTypeIndex()` → `Map<pluginId, StepTypeContribution>`
  from `Workflows.StepType.useContributions()`.
- `web/internal/create-definition.ts` — `createDefinitionAndOpen(openPane)`: POST `createDefinition`
  `{ name: "Untitled workflow" }` then `openPane(definitionDetailPane, { definitionId }, {mode:"push"})`.
- `web/panes.tsx` — `definitionsRootPane` (welcome body "Select or create a workflow"),
  `definitionDetailPane` (+ `useResolveDefinition`). Exports both panes (executions needs
  `definitionsRootPane` as ancestor).
- `web/components/workflows-sidebar.tsx` — `WorkflowsSidebar` (mirrors `pages-sidebar.tsx`):
  `SidebarPaneSection` (`title:"Workflows"`, `icon:MdSchema`, `labelExtra: WorkflowsHeaderAdd`) →
  `Scroll fill` → `DataView<WorkflowDefinition> views={["list"]}` with
  `storageKey={defineDataView("workflows.definitions")}` (call lives here), fields: `name`
  (primary, `onEdit`→`updateDefinition`), `steps` (count, `type:"number"`, align end), `updatedAt`
  (`cell`→`<RelativeTime/>`); `selectedRowId` from `definitionDetailPane.useRouteEntry()`;
  `onRowActivate`→push detail. `WorkflowsHeaderAdd` mirrors `PagesHeaderAdd`.
- `web/components/definition-detail.tsx` — `DefinitionDetail({definitionId, def})`: editable
  title/description (`useEditableField` or controlled input → `updateDefinition`), delete action
  (`deleteDefinition` → open root), read-only ordered step list (icon via `useStepTypeIndex`, label,
  entry-step marker, `next`/`nextStepMapping` summary, empty-state), then
  `<WorkflowsDetail.Section.Render>` host (Surface-wrapped sections).
- `web/index.ts` — contributions: `WorkflowsApp.Sidebar({title,icon,component:WorkflowsSidebar})`
  (note: `AppShellSidebarItem` = exactly `{title,icon,component}`, no `id`), `Pane.Register` for both
  panes. Re-exports `WorkflowsDetail`, `definitionsRootPane`, `definitionDetailPane`.

### Plugin B — `plugins/apps/plugins/workflows/plugins/executions/`
- `package.json` — `@singularity/plugin-apps-workflows-executions`, `private`, `version 0.0.1`.
- `web/internal/use-step-type-index.ts` — local copy of the slot-read hook.
- `web/panes.tsx` — `executionDetailPane` (+ `useResolveExecution` from
  `workflowExecutionsDescriptor`); body → `<PaneChrome title={Execution <id8>}><ExecutionDetail/></>`.
  Imports `definitionsRootPane` from `definitions/web` as ancestor.
- `web/components/execution-status-badge.tsx` + `step-status-badge.tsx` — local, modeled on
  `server-status-badge.tsx`. Colors: completed→`bg-success`, failed→`bg-destructive`,
  running→`bg-info`, suspended→`bg-warning`, pending/skipped→`bg-muted-foreground`.
- `web/components/run-definition-button.tsx` — `RunDefinitionButton({definitionId})`: Button → POST
  `createExecution { definitionId }`.
- `web/components/executions-section.tsx` — `ExecutionsSection({definitionId})`:
  `useResource(workflowExecutionsDescriptor)` filtered by `definitionId` →
  `DataView<WorkflowExecution> views={["list"]}` with
  `storageKey={defineDataView("workflows.executions")}` (call lives here), fields: `status`
  (`cell`→badge), `created`/`completed` (RelativeTime), `steps` (count); `actions={<RunDefinitionButton/>}`;
  `onRowActivate`→push execution detail; `emptyState="No runs yet."`.
- `web/components/execution-detail.tsx` — `ExecutionDetail({execution})`: status badge + timing, then
  `execution.steps` sorted by `executionOrder`, each wrapped in `PluginErrorBoundary`, rendering the
  matched `executionComponent` if present else `GenericStepTrace` (label, step-type icon, status
  badge, started/completed, collapsible JSON input/output, error). Cancel action → `deleteExecution`.
- `web/index.ts` — contributions: `WorkflowsDetail.Section({id:"executions", title:"Executions",
  order:10, component:ExecutionsSection})` (`WorkflowsDetail` imported from `definitions/web`),
  `Pane.Register({pane:executionDetailPane})`.

### Config files (authored; `.origin.jsonc` is build-generated)
- `config/apps/workflows/definitions/workflows.definitions.jsonc` — `{ "views":[{"name":"All","view":{"type":"list"}}] }`
- `config/apps/workflows/executions/workflows.executions.jsonc` — same shape.

## Build sequence

1. Create `definitions` plugin files + its config jsonc.
2. `./equin build` — regenerates registry/origin/CLAUDE.md. Verify sidebar list, welcome pane,
   detail pane; create/rename/delete a definition.
3. Create `executions` plugin files + its config jsonc.
4. `./equin build`. Verify the Executions section in detail, Run → immediately-completed
   execution, execution-detail pane status/timing + step trace.
5. `./equin check` (esp. `data-view:configs-authored`, `data-views-in-sync`,
   `plugins-registry-in-sync`, boundaries, `type-check`).

## Verification (end-to-end)

- Screenshot `http://att-1782753993-ipca.localhost:9000/workflows` — sidebar shows the Workflows
  list (empty-state initially).
- Scripted Playwright (`e2e/screenshot.mjs`): click the sidebar "+" → a new definition opens; rename
  it; the Executions section shows "No runs yet."; click **Run** → a new completed execution row
  appears (live-state push); click it → execution-detail pane shows a completed status badge + timing.
- `mcp__singularity__query_db`: confirm rows land in `workflow_definitions` and `workflow_executions`.

## Follow-up tasks (file via add_task)

1. **Trivial demonstrable step type** (`steps/noop` / `set-output`) with a real `executionComponent`
   — unblocks a non-empty, meaningful multi-step trace.
2. **Visual step-graph editor** in the definition detail (add/remove/reorder steps, edit `config` via
   `Workflows.StepType.configComponent`, set `entryStepId`, wire `next`/`nextStepMapping`).
3. **Richer execution breadcrumb**: nest `executionDetailPane` under `definitionDetailPane`
   (`segment:"def/:definitionId/exec/:executionId"`).
4. **Toolbar contributions** for the empty `WorkflowsApp.Toolbar`.
5. **Suspended-execution UX**: surface user-input steps via the existing `submitStep` endpoint.

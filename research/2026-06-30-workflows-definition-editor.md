# Workflows definition editor — visual step-graph authoring

## Context

The Workflows app can list, create, open, run, and inspect definitions/executions, but a
created definition is **always empty**: there is no UI to add steps, set the entry step,
configure a step's `config` (the `Workflows.StepType.configComponent` slot field is
declared but unused), or wire `next` / `nextStepMapping` routing. Without this, workflows
can't express any logic — every definition runs to immediate completion (`run-job.ts`
returns when `entryStepId` is null).

This adds a **visual step-graph editor** to the definition-detail pane, built on the
existing `graph-canvas` primitive, plus the first real `configComponent` (the branch
step's config form) to exercise the per-type config seam.

This is a **frontend-only** feature: the `PATCH /api/workflows/definitions/:id` endpoint
already accepts `steps` (`z.record`) and `entryStepId`, and `run-job.ts` already
interprets `next` / `nextStepMapping` / `entryStepId` generically. No schema/engine change.

## Data model recap

`DefinitionStep` (`engine/core/schemas.ts`): `{ id, pluginId, label, config: Record, next: string|null, nextStepMapping: Record<key,stepId>|null }`.
`WorkflowDefinition`: `{ …, steps: Record<stepId, DefinitionStep>, entryStepId: string|null }`.

Routing semantics (from `run-job.ts`): start at `entryStepId`; after a step, if the
executor returned a `branchKey` present in `nextStepMapping`, go there; otherwise follow
`next`. So **the default path is `next`; named/conditional paths are `nextStepMapping`
keys**. This maps cleanly to "every step has one default edge plus zero-or-more named
edges" — a fully generic model that never names the `branch` step type (collection-consumer
clean: the editor only consumes the `Workflows.StepType` slot).

## Architecture

New sub-plugin **`plugins/apps/plugins/workflows/plugins/editor`** (web-only) exporting a
single `DefinitionEditor` component. The `definitions` detail pane imports and renders it
in place of the current read-only `StepList`. Rationale: keeps `definitions` focused on
sidebar/pane chrome; the editor is a cohesive authoring unit that consumes the generic
`Workflows.StepType` slot. Normal import edge `definitions → editor → engine` (no cycle).

The genuine extensibility seam (per-step-type config UI) stays where it belongs: each step
plugin contributes its own `configComponent` via `Workflows.StepType`. The editor renders
whatever the selected step's type contributed, inside a `PluginErrorBoundary`.

### Files

```
plugins/apps/plugins/workflows/plugins/editor/
  package.json
  web/index.ts                      # barrel: export { DefinitionEditor }; default definePlugin
  web/components/definition-editor.tsx   # orchestrator: toolbar + canvas + inspector
  web/components/add-step-menu.tsx       # "Add step" dropdown over StepType contributions
  web/components/step-inspector.tsx      # selected-step editing panel
  web/internal/use-step-type-index.ts    # index StepType slot by pluginId (mirror existing)
  web/internal/step-graph.ts             # WorkflowDefinition → GraphCanvasNode[]/Edge[]
  shared/step-ops.ts                     # PURE step-map transforms (add/delete/connect/route/entry)
  shared/step-ops.test.ts                # bun:test for referential integrity
```

`step-ops.ts` is plugin-private `shared/` (pure functions, used only by web here, but kept
DRY-able and unit-testable). All ops take the current `WorkflowDefinition` and return
`{ steps, entryStepId }` to PATCH.

### Persistence

One helper `persistDef(definitionId, patch)` → `fetchEndpoint(updateDefinition, {id}, {body})`.
Source of truth stays the `workflowDefinitionsDescriptor` live resource (already wired in the
pane). Structural ops (add / delete / connect / set-entry / route edits) are discrete and
low-frequency → PATCH immediately; the live push re-renders the canvas.

Config edits are higher-frequency → the inspector holds a `draftConfig` local state keyed by
`selectedStepId` (reset only when the selected step changes, **not** on every push, to avoid
clobbering mid-edit), and debounce-saves (~350ms) with flush on selection-change/unmount.
This centralizes the debounce so `configComponent` authors can call `onChange` on every
keystroke. The step `label` uses the existing `useEditableField` primitive.

### Interaction

**Toolbar** (above canvas): `Add step` dropdown listing every `StepType` contribution
(icon + label). Picking one calls `addStep(def, pluginId)` → new step id
`step-${crypto.randomUUID().slice(0,8)}`, empty config, label = type label; if it is the
first step, also set it as `entryStepId`. Then select it.

**Canvas** (`<GraphCanvas connectable edgePath="smoothstep" direction="LR" onNodeClick onConnect>`):
- Node = step. `leading` = type icon; `label` = step.label||type.label. Entry step gets
  `ringClass` emphasis + an "Entry" `badge`. Selected step gets a distinct ring.
  `connectable: true`. `actions` (hover, top-right) = set-entry + delete icon buttons.
- Edges: default `next` → solid `tone:"default"`; each `nextStepMapping[key]` →
  `tone:"muted"` with `actions` = a small chip showing `key` + a remove button. Default edge
  `actions` = remove button only. (graph-canvas has no edge label text; the key chip lives in
  `edge.actions`, hover-revealed — the inspector is the always-visible authoritative view.)
- `onConnect(source, target)`: if `source.next == null` → set `next = target`; else add
  `nextStepMapping["case-N"] = target` (N = next free index) and select source so the user
  can rename the key. Guard against self-loops only if they'd break layout? (allow; engine
  tolerates, but skip creating an exact duplicate edge.)
- `onNodeClick(id)` → select step (opens inspector).

**Inspector** (right column ~300px when a step is selected; stacks under canvas on narrow
widths via flex-wrap):
- Header: type icon + type label; `Set as entry` button (hidden if already entry / shows
  "Entry" state); `Delete step` (destructive).
- `Label`: `useEditableField` text input.
- `Configuration`: `stepType.configComponent` rendered with `{config: draftConfig, onChange}`
  in a `PluginErrorBoundary`; fallback "No configuration for this step type." when absent.
- `Routing`:
  - **Default next**: `<select>` of every other step + "— none (end) —" → sets `next`.
  - **Conditional routes**: list of `{key input (commit on blur), target <select>, remove}`
    + `Add route`. Editing a key remaps `nextStepMapping`; empty/duplicate keys are rejected
    on blur (revert).

**Delete step** (`deleteStep`): drop `steps[id]`; for every other step null any `next===id`
and remove any `nextStepMapping` entries whose value `===id`; if `entryStepId===id` set null.

### Branch `configComponent` (in the `branch` plugin)

`plugins/apps/plugins/workflows/plugins/steps/plugins/branch/web/components/branch-config.tsx`.
Config shape `{ field: string; defaultBranch?: string }`:
- `Field path` text input — dot-path into the previous step's output that selects the branch
  key (matches `executor.ts` `getByDotPath`).
- `Default branch key` text input — used when the field is absent/null.
- Short helper text: "The resolved value is matched against this step's conditional route
  keys." Uses raw inputs calling `onChange({...config, field})` (inspector debounces).
Contribute via the existing `Workflows.StepType({ pluginId:"branch", …, configComponent })`.

## Out of scope / follow-ups

- **Action step types.** Only `branch` exists, so authored graphs are runnable but not yet
  *useful* (branches with no action). File a follow-up to add ≥1 leaf/action step type
  (e.g. an HTTP-call or a "set constant output" step) so end-to-end workflows do real work.
- Drag-to-reposition / manual layout (dagre auto-layout is sufficient and avoids storing
  positions).
- Validation surfacing (unreachable steps, dangling targets) — the canvas makes these
  visible; explicit lint can come later.

## Verification

1. `./equin build` (from the worktree).
2. `bun test plugins/apps/plugins/workflows/plugins/editor/shared/step-ops.test.ts`.
3. Open `http://<worktree>.localhost:9000/workflows`, create a workflow, add 2–3 branch
   steps, set an entry, drag-connect them, add a conditional route + key, configure a
   branch's field path. Reload → state persisted (live resource).
4. Run the definition (existing Run button) → execution trace shows the steps executing and
   routing per the wired edges.
5. Scripted Playwright run (`bun e2e/screenshot.mjs`) capturing the editor with a small graph.
```

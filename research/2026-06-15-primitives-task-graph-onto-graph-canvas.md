# Migrate `tasks/task-graph` onto the `graph-canvas` primitive

## Context

The Studio closure-graph canvas introduced `primitives/graph-canvas` — a generic dagre + xyflow
plugin behind a domain-agnostic node/edge API. But `tasks/task-graph` still carries its **own inline
copy of the same xyflow + dagre stack**, so the rendering layer (dagre layout, ReactFlow wiring,
ResizeObserver-driven fit, custom HTML nodes, edge styling) now exists twice. The two will drift.

The catch: `task-graph` is an **editor**, not just a viewer. On top of the shared rendering it adds:

- **drag-to-connect** — drag between node handles to create a dependency (`onConnect → addTaskDependency`),
- **per-node delete** — a hover-revealed corner "×" that soft-drops the task (`patchTask({drop:true})`),
- **insertable edges** — hover-revealed mid-edge "+"/"×" buttons (insert-between / remove-dependency),
- **group-background layers** — dashed rectangles enclosing tasks that share a `groupId`, palette-cycled by nesting depth.

The current `graph-canvas` is a strictly read-only viewer (`nodesDraggable/nodesConnectable/edgesFocusable/elementsSelectable`
all `false`, single fixed node type, no custom edge, no background layer). The migration must **grow the
primitive with optional editor affordances without changing the read-only path** — the only existing
consumer (Studio's `graph-view.tsx`) must stay **byte-identical** at its call site and pixel-identical on screen.

Intended outcome: one rendering stack. `task-graph` becomes a thin **mapper** from `TaskListItem`
closure → generic nodes/edges/groups; the primitive owns all xyflow/dagre mechanics.

## Design principle

Every new capability is an **optional field defaulting to current behavior**. The Studio mapper emits
only the existing required fields (`label`/`title`/`tintClass`/`ringClass` + edge `variant`), so its
output maps onto unchanged defaults. All domain logic (endpoints, closure walk, palette, button JSX)
stays in the consumer; the primitive receives only `ReactNode`s and `(source, target) => void` callbacks
and never imports anything beyond `primitives/ui-kit.cn` + its existing `dagre`/`@xyflow/react` libs.

### Primitive API additions (`graph-canvas/web`)

`GraphCanvasNode` (add, all optional):
- `leading?: ReactNode` — shrink-0 content before the label (e.g. a status icon). Keeps the primitive's
  `min-w-0 flex-1 truncate` label span — **truncation stays primitive-owned** (do NOT add a full-body
  `content` escape hatch; both consumers are "optional leading icon + truncating label").
- `labelClassName?: string` — extra classes on the existing label span (e.g. `italic line-through` for dropped tasks).
- `actions?: ReactNode` — hover-revealed absolute corner overlay (the delete "×"). Primitive owns the
  positioning (`top:-8 right:-8`), hover-gated opacity, and the required `nodrag nopan pointer-events-auto` wrapper.
- `connectable?: boolean` — opt this node into visible, draggable connect handles (only effective when the
  canvas is `connectable`).

`GraphCanvasEdge` (add, all optional):
- `tone?: "default" | "muted" | "success"` — semantic stroke color mapped inside the primitive
  (`var(--foreground)` / `var(--muted-foreground)` / `var(--success)`). Orthogonal to `variant`
  (dash vs solid). **Use a closed semantic set, not a raw `color` string** — keeps token knowledge in the primitive.
- `actions?: ReactNode` — hover-revealed mid-edge overlay (the "+"/"×" buttons). Primitive owns the wide
  invisible hit-path, the `EdgeLabelRenderer` portal, hover opacity, and `nodrag nopan pointer-events-auto`.

`GraphCanvasProps` (add):
- `connectable?: boolean` (default `false`) — sets ReactFlow `nodesConnectable`, `connectionRadius={20}`,
  `connectionLineType={SmoothStep}`.
- `onConnect?: (source: string, target: string) => void` — unwrapped from xyflow's `Connection`
  (id-less handles ⇒ `{source, target, sourceHandle:null, targetHandle:null}`). Direction passes through
  verbatim; the consumer owns semantics (`A→B` edge = "B depends on A").
- `groups?: GraphCanvasGroup[]` — background rectangles (see below).
- `minZoom?: number` (default `0.3`).
- `edgePath?: "bezier" | "smoothstep"` (default `"bezier"`).

New type: `GraphCanvasGroup = { id: string; label: string; memberIds: string[]; className?: string; labelClassName?: string }`.
The primitive computes each group's bounding box **after** dagre layout from member node positions and
renders a dashed-rounded background node behind the rest. Palette/depth styling stays in the consumer
(passed as resolved `className`/`labelClassName`).

### Key xyflow mechanics (the traps)

- **Custom edge type registered but applied conditionally.** Register `EDGE_TYPES` always (cheap), but only
  set `type: CANVAS_EDGE_TYPE` on an edge when it has `actions` **or** `edgePath === "smoothstep"`. Edges
  with neither stay untyped → xyflow's built-in bezier → Studio's edges are literally unchanged. Don't try
  to prove a custom component is pixel-identical to the default; just don't use it there.
- **Handles always mounted.** When the canvas is not `connectable`, handles stay exactly as today
  (`!opacity-0`, `isConnectable={false}`). When connectable, per-node `connectable` switches them to the
  editor style (`!bg-muted-foreground/60`, `size-2.5`, crosshair, hover-gated opacity, `isConnectable`).
- **Group nodes excluded from dagre, prepended to flowNodes.** Never `g.setNode` a group. After
  `dagre.layout`, bbox from `g.node(memberId)` with `GROUP_PAD=16`, `GROUP_LABEL_HEIGHT=18`; build bg nodes
  with `pointerEvents:"none"`, `selectable:false`, `draggable:false`; sort by caller order; prepend so they
  render behind. **The consumer must include the group's anchor task in `memberIds`** (matching the current
  `members.push(groupId)` quirk) or the box is drawn too small.
- **Filter group nodes out of `onNodeClick`.** The primitive must not surface background-node ids to the
  consumer's `onNodeClick`.
- **`fitKey` must include group ids:** `[...nodes.map(n=>n.id), ...(groups??[]).map(g=>g.id)].join("|")`,
  so adding/removing a group (without a real-node change) still triggers a refit.

## Files to change (in order)

1. **`plugins/primitives/plugins/graph-canvas/web/components/canvas-node.tsx`** — extend `CanvasNodeData`
   (`leading`, `labelClassName`, `actions`, `connectable`); add internal hover state; render `leading`
   (shrink-0) + label span (keep `min-w-0 flex-1 truncate`, append `labelClassName`); conditional handle
   styling; corner `actions` overlay with `nodrag nopan pointer-events-auto`. Keep inline trailing `badge` as-is.
2. **`plugins/primitives/plugins/graph-canvas/web/components/canvas-edge.tsx`** (new) — `CanvasEdge`
   (`CANVAS_EDGE_TYPE`). Pick `getBezierPath`/`getSmoothStepPath` by `edgePath`; render bare
   `<BaseEdge path style markerEnd/>`; when `actions`, add the `<g>` hover wrapper + 20px transparent hit
   path + `EdgeLabelRenderer` overlay.
3. **`plugins/primitives/plugins/graph-canvas/web/components/group-background.tsx`** (new) — generic
   `GROUP_BG_TYPE` node: `relative size-full rounded-lg border border-dashed pointer-events-none` + corner
   label span; all color from caller `className`/`labelClassName`. No `primitives/text` import.
4. **`plugins/primitives/plugins/graph-canvas/web/components/graph-canvas.tsx`** — extend the three
   interfaces + add `GraphCanvasGroup`; in `layout()` map `tone`→stroke, set edge `type` conditionally,
   thread node fields into `data`, compute group bboxes and prepend bg nodes; register group + edge types;
   in `GraphCanvasInner` wire `nodesConnectable`/`connectionRadius`/`connectionLineType`/`onConnect`/`minZoom`
   and filter group ids from `onNodeClick`; extend `fitKey`.
5. **`plugins/primitives/plugins/graph-canvas/web/index.ts`** — export `GraphCanvasGroup`; update the
   `description` to note the (default-off) editor affordances.
6. **`plugins/tasks/plugins/task-graph/web/components/task-graph.tsx`** — delete the inline
   dagre/ReactFlow/`layoutDag`/`TaskNode`/`GroupBackground`/`TaskGraphInner`/handle code. Keep
   `computeDagClosure`, `getGroupDepth`, `GROUP_PALETTE`, `isNonBlocking`, navigation, the `onConnect`
   endpoint call, and the delete-button JSX. Map closure → `GraphCanvasNode[]` (`leading` icon, `label`
   title, `labelClassName` for dropped, `ringClass` for selected, `actions` delete when `!hasChildren`,
   `connectable`), `GraphCanvasEdge[]` (`tone` via `isNonBlocking`, `actions` = +/× buttons), and `groups`
   (memberIds incl. anchor; `className`/`labelClassName` from palette). Render `<GraphCanvas … connectable
   onConnect edgePath="smoothstep" minZoom={0.5} direction="LR"/>` inside the existing
   `h-60 shrink-0 border-b` container.
7. **`plugins/tasks/plugins/task-graph/web/components/insertable-edge.tsx`** — demote to a presentational
   "+"/"×" button cluster the consumer passes as edge `actions` (keeps `fetchEndpoint`/`insertTaskBetween`/
   `removeTaskDependency`/`Text`/`onNavigate`). It no longer defines an edge type. (May be folded inline into
   `task-graph.tsx` and deleted.)
8. **CLAUDE.md reference blocks** — regenerated by `./equin build`; verify `graph-canvas` Description
   + "Imported by: tasks/task-graph" and `task-graph` "Uses: primitives/graph-canvas.GraphCanvas" land correctly.
9. **No-regression check** — confirm `studio/graph/web/components/graph-view.tsx` and `internal/subgraph.ts`
   need **zero** edits.

## Plugin-boundary guardrails

- `graph-canvas` must gain **no** new cross-plugin import. All of `fetchEndpoint`, `addTaskDependency`,
  `removeTaskDependency`, `insertTaskBetween`, `patchTask`, `Text` stay in `task-graph`, injected as
  `actions`/`onConnect` props. Group labels use a plain styled `<span>`, not `primitives/text`.
- New edge in the graph: `graph-canvas ← tasks/task-graph` (previously only `studio/graph`). DAG preserved.

## Verification

1. `./equin build` from the worktree; confirm checks pass (`type-check`, `plugin-boundaries`,
   `plugins-doc-in-sync`, `plugins-registry-in-sync`).
2. Open `http://att-1781537540-9ttv.localhost:9000` → a task with dependencies/dependents (closure > 1) so
   the graph band renders. Verify against `main` behavior:
   - drag from a node's right handle to another's left handle → dependency created (edge appears);
   - hover an edge → "+"/"×" appear; "+" inserts a task & navigates, "×" removes the dependency;
   - hover a leaf node → corner "×" appears; click → task drops (italic/line-through);
   - group rectangles enclose grouped tasks with depth-cycled palette;
   - click a task node → navigates; clicking a group background does nothing.
   Use `e2e/screenshot.mjs --click` for the connect/insert/delete interactions (before/after).
3. Open Studio → `/studio` graph pane and confirm the closure canvas is visually unchanged (edges still
   plain bezier, no stray handles, click-to-recenter works).
4. Diff sanity: `git diff $(git merge-base HEAD main) -- plugins/apps/plugins/studio` should be **empty**.

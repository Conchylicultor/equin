# Closure-Graph Canvas for Plugin Compositions (Studio)

## Context

Studio can already visualize composition **membership** as a tinted plugin
*tree* (the explorer membership band) and edit/compare composition drafts (the
compositions pane). What it cannot do is show the **dependency graph itself** —
the closure DAG, with entry points highlighted and hard (import) vs soft
(slot-contribution) edges styled differently. A tree hides the cross-cutting
edges that the closure engine actually computes; a graph makes the structure
(why a plugin is pulled in, what it drags along, who depends on it) legible.

Rendering all ~500 nodes at once is not viable, so the canvas is **scoped to a
focused subgraph** around a selected node: walk outward in **both directions**
(dependencies *and* dependents) to a depth radius, capped at a node budget, and
recenter on click.

The closure engine (`plugin-meta/closure`) and the composition web store
(`plugin-meta/composition`) already expose everything required — `EdgeGraph`
with both-direction hard/soft adjacency maps, the active `CompositionManifest`,
and a total `MembershipState` map. This is a **rendering** task on top of
shipped data, not a new engine.

## Decisions (locked with user)

- **Renderer:** `@xyflow/react` + `dagre` — the repo's existing graph stack
  (already used inline by `tasks/task-graph`, already in the root workspace).
  Chosen on merit: React-component nodes make membership tinting trivial (reuse
  Tailwind tokens), and correct pan/zoom/fit is already solved. Rather than a
  *third* inline copy, wrap it behind a new **generic `graph-canvas`
  primitive**. The closure canvas is its first consumer; `task-graph` migration
  is a deferred follow-up (it has editor features — drag-to-connect, delete,
  group backgrounds — out of scope here).
- **Traversal:** both directions (deps + dependents), depth radius + node cap,
  hard/soft edges styled distinctly. Depth + direction adjustable in-canvas.
- **Overlay:** when a composition is active, tint nodes by `MembershipState`
  (reuse the explorer's `STATE_TINT`) and ring the entry points; plain
  structural styling when none is active.

## Architecture

Three layers, cleanly separated:

1. **`primitives/graph-canvas`** (new, generic) — owns dagre layout + xyflow
   viewport + node/edge rendering behind a domain-agnostic API. Knows nothing
   about plugins, closures, or membership.
2. **closure subgraph derivation** (pure helper in the new Studio pane plugin) —
   BFS over the shipped `EdgeGraph` to produce the focused, capped subgraph;
   maps `MembershipState` → tint and edge `kind` → variant.
3. **`apps/studio/.../graph` pane** (new) — Studio sidebar entry + pane that
   wires the store hooks to the primitive, plus the in-canvas controls (focus
   search, depth, direction, legend) and click-to-recenter.

---

## Part A — `primitives/graph-canvas` primitive (new, generic)

**Location:** `plugins/primitives/plugins/graph-canvas/`
Files:
- `package.json` — `{ name: "@singularity/plugin-primitives-graph-canvas", private, version, description }`. Declare `@xyflow/react` + `dagre` here as explicit owner (both already hoisted from root, so this is documentation of ownership; no root change needed).
- `web/index.ts` — barrel: `export { GraphCanvas } from "./components/graph-canvas"` + the public types. **No `definePlugin`** is required for a pure component-library primitive (cf. `truncating-text`, `tooltip`); barrel exports only.
- `web/components/graph-canvas.tsx` — the component (lift the proven bits from `tasks/task-graph/web/components/task-graph.tsx`: `dagre.graphlib.Graph` LR layout, `ReactFlowProvider`, `fitView`-on-`ResizeObserver`, `Background`, `proOptions={{hideAttribution:true}}`, `minZoom/maxZoom`).
- `web/components/canvas-node.tsx` — custom node (HTML/Tailwind so tint classes apply directly).

**Public API (domain-agnostic):**
```ts
export interface GraphCanvasNode {
  id: string;
  label: string;
  title?: string;               // tooltip (e.g. full id)
  tintClass?: string | null;    // background tint (Tailwind)
  ringClass?: string | null;    // emphasis ring (focus / entry)
  badge?: ReactNode;            // optional corner content
}
export interface GraphCanvasEdge {
  from: string;
  to: string;
  variant?: "solid" | "dashed"; // generic; closure maps hard→solid, soft→dashed
  emphasized?: boolean;
}
export interface GraphCanvasProps {
  nodes: GraphCanvasNode[];
  edges: GraphCanvasEdge[];
  focusId?: string;             // node to emphasize + fit around
  direction?: "LR" | "TB";      // dagre rankdir, default "LR"
  onNodeClick?: (id: string) => void;
}
export function GraphCanvas(props: GraphCanvasProps): JSX.Element;
```

The primitive maps `variant: "dashed"` → `strokeDasharray` + a soft stroke color
(`var(--muted-foreground)`), `"solid"` → solid; `MarkerType.ArrowClosed` on
edges. Node component renders `label` over `tintClass`, applies `ringClass`,
truncates long labels, shows `title` tooltip. Read-only viewer defaults:
`nodesDraggable={false}`, `nodesConnectable={false}`, `elementsSelectable={false}`,
`panOnDrag`, `zoomOnScroll`. Re-fit on `focusId`/node-set change.

---

## Part B — Closure subgraph derivation (pure helper)

**Location:** `plugins/apps/plugins/studio/plugins/graph/web/internal/subgraph.ts`
A pure function over the shipped, deserialized `EdgeGraph`:

```ts
function focusSubgraph(
  graph: EdgeGraph,
  focusId: PluginId,
  opts: { depth: number; cap: number },
): { nodeIds: PluginId[]; edges: Edge[]; hiddenCount: number }
```

Algorithm:
- **BFS both directions** from `focusId` to `opts.depth` hops, expanding across
  all four adjacency maps: `hardForward`, `hardReverse`, `softForward`,
  `softReverse`. Track per-node hop distance.
- **Cap** to `opts.cap` nodes, nearest-hop-first (focus always included);
  report `hiddenCount = reached − kept` so the UI can surface "+N hidden".
- **Edges:** for each kept node, emit `hardForward` targets (kind `"hard"`) and
  `softForward` targets (kind `"soft"`) **whose target is also kept** — true
  directed edges with their real kind, deduped. (Using forward-only over the kept
  set yields every edge exactly once with correct direction.)

Co-locate `subgraph.test.ts` (`bun:test`) asserting: focus included; depth
honored; cap respected with correct `hiddenCount`; both hard and soft edges
present with right kinds; edges restricted to kept nodes.

A second small mapper builds `GraphCanvasNode[]`/`GraphCanvasEdge[]`:
- `label = pluginIdSegments(id).at(-1)`, `title = id`.
- `tintClass = membership ? (STATE_TINT[state] ?? null) : null` (no tint when no
  active composition).
- `ringClass`: focus node → strong focus ring (`ring-2 ring-primary`); entry
  membership → entry ring (subtle). Focus ring wins.
- `variant = edge.kind === "hard" ? "solid" : "dashed"`.

---

## Part C — Studio closure-graph pane (new sub-plugin)

**Location:** `plugins/apps/plugins/studio/plugins/graph/`
Mirror the `compositions` sub-plugin structure byte-for-byte.

- `package.json` — standard plugin package (no deps; primitive + xyflow hoisted).
- `web/panes.tsx`:
  ```ts
  export const graphCanvasPane = Pane.define({
    id: "graph",
    segment: "graph",
    component: GraphBody,
    chrome: false,
    width: 900,
    input: paneInput<{ focusId?: PluginId }>(),   // match existing input pattern
  });
  ```
  `GraphBody` composes `<PaneChrome pane={graphCanvasPane} title="Plugin Graph">`
  with a `h-full overflow-hidden` wrapper around the canvas (PaneChrome's scroll
  area goes inert when the child fills it — per the css skill's custom-viewport
  note).
- `web/index.ts` — barrel:
  ```ts
  contributions: [
    Pane.Register({ pane: graphCanvasPane }),
    Studio.Sidebar({ id: "graph", ...sidebarNavItem({
      title: "Plugin Graph", icon: MdHub,
      onClick: () => openPane(graphCanvasPane, {}, { mode: "root" }),
    })}),
  ]
  ```
- `web/components/graph-view.tsx` — the pane body:
  - Data: `useCompositionData()` (graph + `allIds` for focus search + `isLoading`),
    `useActiveMembership()`, `useActiveComposition()` (entry default). `Loading`
    while fetching.
  - **Focus state:** local `useState`, seeded from pane param `focusId` →
    else active composition's first `entryPoints[0]` → else unset. Clicking a
    node sets focus (recenter). Independent of `pinAsRoot` (navigating the graph
    must not mutate the composition draft).
  - **Empty state:** no focus → prompt + `SearchInput` over `allIds` to pick one.
  - **Toolbar** (compose `Bar`/pane-toolbar): focus label + focus search
    (`SearchInput`), depth stepper (default **2**), direction toggle
    (`SegmentedControl`: Both / Deps / Dependents — default **Both**; Deps =
    forward-only, Dependents = reverse-only), node-cap note ("+N hidden" when
    capped), and a compact membership legend (reuse `STATE_TINT` + a new
    `STATE_LEGEND`).
  - Derive subgraph (Part B) in `useMemo` keyed on `(graph, focusId, depth,
    direction, membership)`; render `<GraphCanvas …>`.

---

## Part D — Export the shared membership tint (single source of truth)

`STATE_TINT` is currently a **private** const in
`plugins/apps/plugins/studio/plugins/explorer/plugins/membership/web/components/membership-band.tsx`.
Export it (and add a `STATE_LEGEND: { state, label, tint }[]` ordered list) from
that plugin's **barrel** (`.../membership/web/index.ts`), exactly as `DIFF_TINT`
/ `DIFF_LEGEND` are already exported and reused by `compositions`. The graph
pane imports `STATE_TINT` + `STATE_LEGEND` from
`@plugins/apps/plugins/studio/plugins/explorer/plugins/membership/web` — no color
duplication, no drift. (Legal cross-plugin barrel import; same precedent as
`compositions` → `membership`.)

---

## Part E — "Open in graph" affordance (entry into focus)

Add a second hover icon button in the explorer membership band's `BandWithPin`
(beside the existing "Show closure from here" pin), e.g. `MdHub` "Open in graph",
that calls `openPane(graphCanvasPane, { focusId: node.id }, { mode: "root" })`.
This makes the band import `graphCanvasPane` from the new graph plugin's barrel —
a one-way `membership → graph` edge (graph never imports membership's component,
only its `STATE_TINT`), so the cross-plugin graph stays a DAG.

(If this creates any awkward edge during implementation, fall back to surfacing
the affordance from `plugin-view` instead; the pane already accepts `focusId`,
so the entry point is decoupled from where the button lives.)

---

## Boundaries / registration

- New plugins are registered by creating their `web/index.ts` barrels and
  running `./equin build` (regenerates `web.generated.ts`; the
  `plugins-registry-in-sync` check enforces it). Never hand-edit the registry.
- All cross-plugin imports are runtime barrels (`…/web`, `…/core`) — compliant
  with the boundary grammar. `./equin check plugin-boundaries` must pass.
- The `plugins-doc-in-sync` check requires regenerated docs — `./equin
  build` handles it; commit the generated docs.

## Critical files

- New: `plugins/primitives/plugins/graph-canvas/{package.json,web/index.ts,web/components/graph-canvas.tsx,web/components/canvas-node.tsx}`
- New: `plugins/apps/plugins/studio/plugins/graph/{package.json,web/index.ts,web/panes.tsx,web/components/graph-view.tsx,web/internal/subgraph.ts,web/internal/subgraph.test.ts}`
- Edit: `plugins/apps/plugins/studio/plugins/explorer/plugins/membership/web/components/membership-band.tsx` (export `STATE_TINT`, add `STATE_LEGEND`, add "Open in graph" button)
- Edit: `plugins/apps/plugins/studio/plugins/explorer/plugins/membership/web/index.ts` (re-export `STATE_TINT`, `STATE_LEGEND`)

## Reuse (do not reinvent)

- xyflow+dagre wiring pattern: `plugins/tasks/plugins/task-graph/web/components/task-graph.tsx` (layout fn, `fitView` ResizeObserver, ReactFlow props).
- Graph data + store: `plugin-meta/closure/core` (`EdgeGraph`, `Edge`, `EdgeKind`, `pluginIdSegments`), `plugin-meta/composition/web` (`useCompositionData`, `useGraph`, `useActiveMembership`, `useActiveComposition`).
- Pane + sidebar pattern: `compositions/web/{index.ts,panes.tsx}`; `sidebarNavItem`, `openPane`, `Pane.define/Register`, `PaneChrome`.
- Tints: explorer `membership` `STATE_TINT` (to be exported).
- UI primitives: `SearchInput`, `SegmentedControl`, `Bar`/pane-toolbar, `Loading`, `IconButton`, `Stack`/`Inset`, `Text`.

## Verification

1. `./equin build` (regenerates registry + docs + migrations, runs checks).
2. `bun test plugins/apps/plugins/studio/plugins/graph/web/internal/subgraph.test.ts` — subgraph BFS / cap / edge-kind correctness.
3. Manual (Playwright) at `http://<worktree>.localhost:9000` → Studio:
   - Open **Plugin Graph** sidebar entry → empty state → search a plugin (e.g.
     `apps.studio.explorer`) → focused subgraph renders, focus node ringed,
     hard edges solid / soft edges dashed, pan/zoom/fit work.
   - In **Compositions**, select a composition → return to graph → nodes tinted
     by membership; entry points ringed; `excluded` untinted. Clear composition →
     tints disappear (structural only).
   - Change depth/direction controls → subgraph grows/shrinks; "+N hidden"
     appears past the cap. Click a node → recenters on it.
   - From **Explorer**, hover a row → "Open in graph" → graph opens focused on
     that plugin.
   Use `e2e/screenshot.mjs --click` to capture before/after for the controls.
4. `./equin check` clean (boundaries, registry-in-sync, doc-in-sync, type-check).

## Follow-ups (not in this change)

- Migrate `tasks/task-graph` onto the `graph-canvas` primitive (needs the
  primitive to grow optional editor affordances: connect handles, per-node
  actions, group-background nodes). File via `add_task` after this lands.
- Composition draft tree-build staleness on live plugin changes is already a
  known follow-up in `composition` (unchanged here).

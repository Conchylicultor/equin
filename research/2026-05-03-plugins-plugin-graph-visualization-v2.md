---
name: Plugin Graph Visualization (v2)
status: proposed
date: 2026-05-03
supersedes: 2026-05-03-plugins-plugin-graph-visualization.md
---

# Plugin Graph Visualization — v2

## What changed from v1

v1 specified ~20 leaf sub-plugins (one per lens, one per rail section, one per filter) and split implementation into 7 sub-tasks. Pulled back: most of those splits were **optionality**, not **modularity/extensibility** — you would never want to disable `rail-importers` without `rail-slot-contributors`, and what gives extensibility is the *slot* existing, not 20 default contributors.

v2 keeps the same architecture and the same four slots, but bundles defaults that ship together into "default packs". Result:

- **7 plugins total** (was ~20).
- **4 implementation tasks** (was 7).
- The slot API is unchanged — any future plugin can still drop in its own lens / rail / filter / toolbar entry.

## Context

(Unchanged from v1 — see [v1](2026-05-03-plugins-plugin-graph-visualization.md#context).) New sidebar entry → global graph of all plugins → click a node for a focused Miller side-column with reverse indexes and deep links. Goals: architectural overview, blast-radius answers, slot/route reverse lookup.

## Decisions

(All unchanged from v1.)

| Question | Decision |
|---|---|
| Data plugin location | `plugins/infra/plugins/plugin-inspector/` |
| Render library | `@xyflow/react` + `dagre` (already in root deps; precedent: `plugins/tasks/plugins/task-graph/`) |
| Umbrella parent/child | Visual nesting via dagre compound graph, not edges |
| Data freshness | One-shot fetch + Reload button (mirrors `publish/`) |
| Lens computation | Client-side, pure over `GraphNode[]` |
| Sidebar group | `"System"` |
| CLI parser | Duplicated subset of `cli/src/docgen.ts`, tagged `// DUPLICATED — unify in v-late` |

## Architecture

### Plugin tree (7 plugins)

```
plugins/
├── infra/plugins/plugin-inspector/        # 1. data layer
└── plugin-graph/                          # 2. umbrella + main pane + slots
    └── plugins/
        ├── default-lenses/                # 3. imports + slots + endpoints + hierarchy
        ├── default-rails/                 # 4. overview + importers + slot-contributors
        │                                  #    + endpoint-callers + deeplinks + exports
        ├── default-filters/               # 5. runtime + loadbearing
        ├── search/                        # 6. toolbar search box
        └── event-lens/                    # 7. parser extension + event lens (later)
```

Each "default" plugin contributes multiple entries to the same slot via a single `contributions: [...]` array — that's exactly what slots are designed for.

### `plugin-inspector` (data layer)

- `shared/index.ts` — exports Zod schemas + types: `GraphPayload`, `GraphNode`, `GraphEdge`, `EdgeKind`, `Runtime`.
- `server/index.ts` — registers `GET /api/plugin-inspector/graph`.
- `server/internal/parser.ts` — duplicated subset of `cli/src/docgen.ts` (`findAllPluginDirs`, `collectPlugin`, `collectAllPlugins`, `computeReverseIndexes`, `buildPluginTree` + supporting regex/transpiler helpers). Tagged with `// DUPLICATED from cli/src/docgen.ts — unify in v-late`.

Wire-format types: see [v1 schema](2026-05-03-plugins-plugin-graph-visualization.md#wire-format-canonical-schema-sub-plugins-consume-these-only) — unchanged.

### `plugin-graph` (umbrella)

- `web/index.ts` — registers `pluginGraphPane` + `pluginGraphNodePane` + `Shell.Sidebar` (group `"System"`); re-exports `PluginGraph` slots.
- `web/slots.ts` — four slots:
  - `PluginGraph.EdgeLens` — `{ id; label; color; getEdges(nodes: GraphNode[]): GraphEdge[] }`
  - `PluginGraph.NodeFilter` — `{ id; label; predicate(node: GraphNode): boolean }`
  - `PluginGraph.Toolbar` — `{ id; component }`
  - `PluginGraph.Rail` — `{ id; order?: number; title; component }`
- `web/panes.tsx`:
  - `pluginGraphPane` — `path: "/plugin-graph"`, content = global graph.
  - `pluginGraphNodePane` — `parent: pluginGraphPane`, `path: "node/:nodeId"`, `chrome: { history: false }`, content = stacked rail sections.
- `web/components/global-graph.tsx` — fetches `/api/plugin-inspector/graph`; reads enabled lenses/filters from `useContributions()`; dagre layout → ReactFlow render. Mirrors `plugins/tasks/plugins/task-graph/web/components/task-graph.tsx`.
- `web/components/focused-view.tsx` — renders `PluginGraph.Rail.useContributions()` sorted by `order ?? 100` (mirrors `plugins/stats/web/components/stats-panel.tsx`).

### Default packs

- **`default-lenses`** — one `web/index.ts` contributing four `PluginGraph.EdgeLens` entries: `imports`, `slots`, `endpoints`, `hierarchy`. The hierarchy lens drives dagre compound mode (`g.setParent(child, parent)`) — implementation detail handled inside `global-graph.tsx` when an edge's `kind === "umbrella"`.
- **`default-rails`** — one `web/index.ts` contributing six `PluginGraph.Rail` entries: `overview` (order 0; name + description + load-bearing + runtime badges), `importers` (forward + reverse), `slot-contributors` (forward + reverse), `endpoint-callers` (forward + reverse), `deeplinks` (Open CLAUDE.md / barrels via `file-pane` primitive), `exports` (collapsible per-runtime list).
- **`default-filters`** — one `web/index.ts` contributing `PluginGraph.NodeFilter` entries: per-runtime checkboxes (web/server/central/shared) + load-bearing toggle.
- **`search`** — contributes `PluginGraph.Toolbar` rendering a search input that highlights + `fitView`s the matched node.
- **`event-lens`** — contributes `PluginGraph.EdgeLens` reading `eventEdges` from the (extended) `GraphPayload`. Requires the parser extension shipped in the same task.

Pathfinder is dropped from v2 — folded into the `search` plugin if/when needed (search → "find path to X" UX), or split out later if it grows enough to deserve its own plugin.

## Implementation tasks (4)

Each row is one delegatable sub-task. Implementation details (exact files beyond shape, layout knobs, copy text, store choice) are intentionally left to the sub-task agent.

| # | Task | Bundles | Depends on | Definition of done |
|---|---|---|---|---|
| 1 | **Foundation** | `plugin-inspector` + `plugin-graph` umbrella + both panes + `default-lenses` (only `imports` enabled) + `default-rails` (only `overview` enabled) | — | Open Plugin Graph from sidebar → ~90 nodes laid out via dagre with import edges → click any node → child column shows overview → URL `/plugin-graph/node/<id>` is shareable. |
| 2 | **Full defaults** | Extend `default-lenses` with `slots` + `endpoints` + `hierarchy` (compound mode) → extend `default-rails` with the five remaining sections → ship `default-filters` → ship `search` | Task 1 | Lens toggles work; hierarchy renders as nested clusters; runtime/load-bearing filters apply pre-layout; reverse-index entries in the rail are clickable and re-focus the graph; search highlights the matched node. |
| 3 | **Event lens** | Extend `plugin-inspector` parser to derive event subscriber→producer edges from `defineTriggerEvent` and `register` token lists; add `eventEdges` to `GraphPayload`; ship `event-lens` plugin | Task 1 | Toggling the Events lens connects `git-watcher` ↔ subscribers; sample-check three known event consumers. |
| 4 | **CLI unification** (later) | Extract parser into a shared workspace package; both `cli/src/docgen.ts` and `plugin-inspector/server/internal/parser.ts` import from it; remove the duplication tag | Task 1 (and ideally Task 3 to avoid re-doing the schema split) | `./equin check` (incl. `plugins-doc-in-sync`) passes; both consumers emit identical reverse indexes for one spot-checked plugin. |

## Critical files / precedents to reuse

(Unchanged from v1.)

- `plugins/tasks/plugins/task-graph/web/components/task-graph.tsx` — primary template for `@xyflow/react` + `dagre`.
- `plugins/publish/server/internal/tree-handler.ts` + `plugins/publish/web/components/publish-view.tsx` — fs walk + one-shot fetch.
- `plugins/stats/web/{index.ts,slots.ts,panes.tsx,components/stats-panel.tsx}` — umbrella + slot + stacked-section render.
- `plugins/conversations/plugins/conversation-view/plugins/tasks-panel/` — toolbar button → child Miller column.
- `plugins/tasks/plugins/task-detail/` — `Rail`-style section slot pattern (and `order` precedent).
- `cli/src/docgen.ts` — parser to clone for Task 1.

## Verification

- After Task 1: open `http://<worktree>.localhost:9000` → Plugin Graph in sidebar → ~90 nodes laid out, import edges drawn → click `tasks-core` → child pane shows correct overview → reload preserves selection via URL.
- After Task 2: cycle each lens toggle (imports/slots/endpoints/hierarchy) → graph re-renders correctly; hierarchy clusters group `infra/*`, `active-data/*`, `stats/*`; runtime filter "server only" hides web-only plugins; search jumps to a node by name; reverse-index entries in the rail are all clickable.
- After Task 3: events lens shows `git-watcher` ↔ its subscribers; spot-check `tasks-core.taskStatusChanged` consumers.
- After Task 4: `./equin check` passes; CLI docgen and the inspector endpoint emit identical reverse indexes for one spot-checked plugin.

## Out of scope

- Editing the graph from the UI.
- Persisting per-user filter/lens preferences.
- Pathfinder UI (folded into `search` if needed; otherwise deferred until requested).
- Migrating `publish/` to consume `plugin-inspector`.
- Extracting dagre+reactflow rendering into a shared `primitives/graph-canvas` (worth flagging — currently duplicated between `task-graph` and `plugin-graph`; separate plan if pursued).

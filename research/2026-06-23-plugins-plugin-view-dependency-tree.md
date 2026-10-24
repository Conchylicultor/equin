# Plugin-view dependency trees (deduped cargo-tree style)

## Context

The plugin-view detail pane (`pluginViewPane`) shows a plugin's runtimes, sub-plugins,
source path, file tree, and composition membership — but **nothing about its place in the
dependency graph**. To understand a plugin you currently have to leave for the Studio graph
pane, which (as the user notes) is hard to parse: a node-graph asks you to trace edges
spatially with no reading order.

Two questions go unanswered in the pane:

- **What does this plugin depend on, recursively?** (its footprint)
- **What depends on this plugin, recursively?** (its blast radius / impact)

This adds both as **deduped cargo-tree-style trees** — the proven solution (`cargo tree` /
`npm ls`) to rendering a DAG cleanly as a tree: a spanning tree where the first occurrence of
a node expands fully and every later occurrence is a marked leaf that is **not** re-expanded,
which kills the diamond/exponential blowup while preserving a linear reading order.

Decisions confirmed with the user:
- **Two separate sections** ("Depends on" / "Used by"), each independently
  collapsible/reorderable/hideable.
- **Both edge kinds** included (hard imports + soft slot-contributions), with soft rows
  subtly marked.

## Approach

A new sub-plugin **`plugins/plugin-meta/plugins/plugin-view/plugins/dependencies/`** (web-only,
sibling of `inclusion` / `sub-plugins`). It owns a shared pure tree-builder + a shared
`DirectionTree` renderer and contributes **two** `PluginViewSlots.Section` entries (forward +
reverse) parameterized by direction. One plugin (not two) because deps/dependents are two faces
of one mechanism sharing all logic; two contributions still gives independent reorder/visibility.

**No new data or endpoint.** The full bidirectional graph is already live client-side via
`useGraph()` from `@plugins/plugin-meta/plugins/composition/web`, returning an `EdgeGraph`
(`hardForward`/`hardReverse`/`softForward`/`softReverse` maps keyed by `PluginId`). `node.id`
(a `PluginId`) is the map key. `useEnsureCompositionData()` populates the store (cached, safe to
call from each section).

### Pure builder — `web/internal/build-dep-tree.ts` (+ co-located `*.test.ts`)

```ts
export type DepDirection = "deps" | "dependents";
export interface DepTreeNode {
  id: PluginId;
  kind: EdgeKind;          // how THIS node was reached from its parent ("hard" | "soft")
  duplicate: boolean;      // true ⇒ first occurrence is elsewhere; render as marked leaf, no children
  children: DepTreeNode[]; // empty when duplicate
}
export interface DepTree { roots: DepTreeNode[]; total: number } // total = distinct plugins in closure

export function buildDepTree(graph: EdgeGraph, rootId: PluginId, direction: DepDirection): DepTree
```

Algorithm (global first-occurrence dedup, deterministic DFS):
- Forward (`deps`): a node's children = `hardForward[id]` (kind `hard`) ∪ `softForward[id]` (kind `soft`).
  Reverse (`dependents`): `hardReverse[id]` ∪ `softReverse[id]`. Use the existing
  `const get = (m, id) => m.get(id) ?? []` idiom (every node is a key, default `[]`).
- Maintain one `seen: Set<PluginId>` across the whole walk (NOT per-path). On reaching a node:
  if already in `seen` → emit `{ duplicate: true, children: [] }`; else add to `seen`, recurse
  into its children. Dedup is **kind-agnostic** (dedupe on id; first edge that reaches it wins).
- The root itself seeds `seen` so a self-edge can't recurse. Graph is a DAG (no cycles, enforced
  by `plugin-boundaries`), so global-first-occurrence both breaks any theoretical cycle and
  collapses diamonds. `total` = `seen.size − 1` (exclude the root).
- If a child id appears under both hard and soft maps for the same parent, keep the **hard**
  occurrence (dedupe the parent's child list by id, hard-first).

This is a faithful generalization of `focusSubgraph`'s BFS in
`plugins/apps/plugins/studio/plugins/graph/web/internal/subgraph.ts` (same `get` idiom, same
four maps) — into a deduped tree instead of a capped flat subgraph.

### Renderer — `web/components/dependency-tree.tsx`

Mirror `sub-plugins-section.tsx`'s recursive `PluginTreeNode` almost verbatim (it is the chosen
template). One `DependencySection({ node, direction })`:
- `useEnsureCompositionData()`; `const graph = useGraph()`.
- `if (!graph) return <Section …><Loading/></Section>` (graph is `null` until fetched).
- `const tree = useMemo(() => buildDepTree(graph, node.id, direction), [graph, node.id, direction])`.
- Empty closure → `<Section><Text tone="muted">No dependencies.</Text></Section>` (forward) /
  `"Nothing depends on this."` (reverse). Never render a blank section.
- `<Section title={direction === "deps" ? "Depends on" : "Used by"} count={String(tree.total)}>`
  then map `tree.roots` to recursive `DepRow`s inside the same `-mx-2` `Stack` bleed as sub-plugins.

`DepRow` (recursive, mirrors `PluginTreeNode`):
- Label = last segment of the id via `pluginIdSegments(id)` (from
  `@plugins/framework/plugins/plugin-id/core`, as `toCanvas` does); `title={String(id)}` for the
  full-id tooltip on hover (disambiguates the many same-short-name plugins).
- Chevron + indent + `Row hover="accent" size="sm"` exactly like `PluginTreeNode`. Chevron only
  when `children.length > 0 && !duplicate`; `onClick` (chevron) stops propagation and toggles
  `useCollapsible`.
- Row `onClick` → `openPane(pluginViewPane, { pluginId: node.id }, { mode: "swap" })` — click a
  dependency to navigate the pane to it (same affordance as sub-plugins).
- **Soft marker:** when `kind === "soft"`, a subtle muted marker on the row (e.g.
  `<Badge variant="info">soft</Badge>` from `primitives/css/badge`, matching the inclusion
  section's hard/soft chip styling). Hard rows render plain.
- **Duplicate marker:** when `duplicate`, no chevron; append a muted `↑` glyph + `title="already
  shown above"` and render no children. (Reuse `Text tone="muted"`; no new primitive.)
- Default expansion: top-level roots (direct deps) are always visible (rendered by the section
  map); deeper levels start collapsed (`useCollapsible` default-closed) and expand on click —
  matching the chosen mockup (direct shown, transitive collapsed-but-expandable).

### Barrel — `web/index.ts`

Two contributions from one plugin (a slot accepts multiple entries):

```ts
contributions: [
  PluginViewSlots.Section({ id: "dependencies", label: "Depends on",
    component: () => <DependencySection direction="deps" /> }),  // component receives { node }
  PluginViewSlots.Section({ id: "dependents", label: "Used by",
    component: () => <DependencySection direction="dependents" /> }),
]
```

(Match the exact `PluginViewSlots.Section` signature used by `inclusion`/`sub-plugins` —
`{ id, label, component }`, `component: ComponentType<{ node: PluginNode }>`. Wrap the
direction via a small per-direction component so each contribution still receives `node`.)

Plus `package.json` (copy a sibling's) and a `CLAUDE.md` (autogen reference block filled by
`./equin build`).

## Files

- **New** `plugins/plugin-meta/plugins/plugin-view/plugins/dependencies/web/internal/build-dep-tree.ts`
- **New** `plugins/plugin-meta/plugins/plugin-view/plugins/dependencies/web/internal/build-dep-tree.test.ts` (bun:test)
- **New** `plugins/plugin-meta/plugins/plugin-view/plugins/dependencies/web/components/dependency-tree.tsx`
- **New** `plugins/plugin-meta/plugins/plugin-view/plugins/dependencies/web/index.ts`
- **New** `plugins/plugin-meta/plugins/plugin-view/plugins/dependencies/package.json`
- **New** `plugins/plugin-meta/plugins/plugin-view/plugins/dependencies/CLAUDE.md`
- No edits to existing files (the section auto-registers via the slot; `./equin build`
  regenerates the registry).

### Reused (do not reinvent)

- `useGraph`, `useEnsureCompositionData` — `@plugins/plugin-meta/plugins/composition/web`
- `EdgeGraph`, `EdgeKind` types — `@plugins/plugin-meta/plugins/closure/core`
- `pluginIdSegments` — `@plugins/framework/plugins/plugin-id/core`
- `Section`, `PluginNode`, `pluginViewPane`, `PluginViewSlots` — `@plugins/plugin-meta/plugins/plugin-view/web`
- `useOpenPane`, `useCollapsible`/`CollapsibleChevron`, `Row`, `Stack`, `Center`, `Text`, `Badge`,
  `Loading` — same primitives `sub-plugins-section.tsx` / `inclusion-section.tsx` already import.
- Template to mirror: `plugins/.../plugin-view/plugins/sub-plugins/web/components/sub-plugins-section.tsx`

## Verification

1. `./equin build` (regenerates the plugin registry + the new section's docs; runs checks).
2. `bun test plugins/plugin-meta/plugins/plugin-view/plugins/dependencies/web/internal/build-dep-tree.test.ts`
   — assert against the real graph (build it like `closure/core/closure.test.ts` does, or pass a
   hand-built `EdgeGraph`): a diamond produces exactly one expandable occurrence + one `duplicate`
   leaf; `total` = distinct closure size; a leaf primitive has empty `deps`; a load-bearing
   plugin has a non-empty `dependents` tree.
3. In the app, open a plugin in the Studio Explorer → plugin-view pane. Confirm "Depends on" and
   "Used by" sections render, counts look right, transitive rows expand, soft edges show the
   marker, duplicates show `↑` and don't re-expand, and clicking a row swaps the pane to that
   plugin. Spot-check a hub (e.g. `infra/endpoints` or `primitives/live-state`) for "Used by"
   and a leaf primitive for "Depends on".
   ```bash
   bun e2e/screenshot.mjs --url 'http://att-1782201970-dj88.localhost:9000/studio' --out /tmp/deptree
   ```

## Follow-ups / notes

- `buildDepTree` eagerly precomputes the full deduped closure (cheap: a few hundred–few thousand
  small objects even for a hub; rows render lazily via collapse). If a very central plugin ever
  makes precompute heavy, switch to compute-children-on-expand with a shared order-stable `seen`
  — deferred; not needed for v1.
- Soft-edge inclusion could later get a per-section toggle (hard-only / both); out of scope now.

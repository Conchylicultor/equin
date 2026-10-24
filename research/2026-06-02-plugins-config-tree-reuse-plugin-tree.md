# Config nav: render the canonical plugin tree (drop bespoke tree)

## Context

The config settings surface (`plugins/config_v2/plugins/settings`) is a two-pane
layout: a left **nav tree** and a right **shared detail pane**. The detail pane
(`config-detail.tsx`) is already generic — one component renders any plugin's
fields. That part is fine and stays.

The problem is the **left nav**. It builds its *own* plugin tree from scratch in
`web/internal/build-config-tree.ts`: it splits each config registration's
`hierarchyPath` on `/`, reassembles a `Map`-based tree, and applies an ad-hoc
"collapse single child into `parent / child`" heuristic. This is boilerplate —
the project already has a **canonical plugin tree** (`buildPluginTree`, served to
the web via `GET /api/plugin-view/tree`). The config view should reuse that
hierarchy instead of reinventing one.

**Intended outcome:** the config nav renders the canonical plugin hierarchy,
pruned to branches that contain at least one config-bearing plugin. The bespoke
tree-builder and its collapsing heuristic are deleted. The 2-pane structure and
the shared detail pane are unchanged.

Decisions already confirmed with the user:
- Keep the current 2-pane structure (tree + shared detail).
- Tree scope: **only config-bearing branches** (a plugin that declares config,
  plus its ancestor nodes for grouping). Configless plugins are hidden.

## Key facts established during exploration

- **Config registrations** come from `useConfigRegistrations()`
  (`plugins/config_v2/web/internal/use-config-registrations.ts`). Each carries
  `{ descriptor, pluginId, pluginName, hierarchyPath, storePath }`.
- **Canonical tree** reaches the web via the endpoint `getPluginTree`
  (`GET /api/plugin-view/tree`), exported from
  `@plugins/plugin-meta/plugins/plugin-view/core` along with the `PluginNode` /
  `PluginTreePayload` types. Each `PluginNode` has `{ name, hierarchyId,
  children, ... }` (already nested; `name` is the dir basename, `hierarchyId` is
  the dotted chain e.g. `backup.google-drive`).
- **The join key.** A registration's `hierarchyPath` (slash-joined, e.g.
  `backup/google-drive`) equals a node's `hierarchyId` with `/`→`.`
  (`backup.google-drive`). Both derive from the same plugin hierarchy with
  `plugins/` segments stripped, so `hierarchyPath.replaceAll("/", ".")` is the
  reliable lookup key into the tree.
- The endpoint returns a rich DTO (all exports/slots/routes/etc.) and rebuilds
  the tree per request. That's heavier than this view strictly needs, but it's
  the existing, shared path (also used by `forge/publish` and `catalog`), so we
  reuse it rather than add a new endpoint.
- The generic `useEndpoint` hook lives in
  `@plugins/infra/plugins/endpoints/web`.

## Approach

### 1. Prune helper — replace `build-config-tree.ts`

New file `web/internal/prune-config-tree.ts` (delete
`web/internal/build-config-tree.ts`):

```ts
import type { PluginNode } from "@plugins/plugin-meta/plugins/plugin-view/core";
import type { ConfigRegistration } from "@plugins/config_v2/web";

export interface ConfigTreeNode {
  node: PluginNode;                 // canonical node (label = node.name)
  registration?: ConfigRegistration; // present iff this plugin declares config
  children: ConfigTreeNode[];        // already pruned
}

// Keep a node iff it (or any descendant) has a config registration.
export function pruneConfigTree(
  roots: PluginNode[],
  byHierarchyId: Map<string, ConfigRegistration>,
): ConfigTreeNode[] { /* recursive filter */ }
```

`byHierarchyId` is built in the nav from `useConfigRegistrations()` keyed by
`reg.hierarchyPath.replaceAll("/", ".")`.

Defensive: track which registrations matched a node; any unmatched registration
(should never happen — same plugin set) is `console.warn`-ed and appended as a
flat root node so a settings page is never silently lost (fail-loud, never hide).

### 2. Unified recursive row — `config-tree-node.tsx`

New file `web/components/config-tree-node.tsx` replaces the
`ConfigNavGroup` helper currently inlined in `config-nav.tsx`. A single
recursive component handles all three cases cleanly (a node can be both
selectable *and* expandable, e.g. `backup`):

- **chevron** when `children.length > 0` (uses `Collapsible` from
  `@plugins/primitives/plugins/collapsible/web`, same as today).
- **label**: clickable when `registration` is present → calls `onSelect(reg)`
  (opens the detail pane); otherwise clicking toggles expand. Label text is
  `registration.pluginName` when config-bearing, else `node.name`.
- **badges**: modified-count badge / conflict warning, shown only for
  config-bearing nodes.

Extract the badge/modified-count logic (currently in `config-nav-row.tsx`) into
a tiny shared hook `useConfigRowState(registration)` so both `ConfigNavRow`
(flat search mode) and `ConfigTreeNode` reuse it — no duplication.

### 3. Rewrite `config-nav.tsx`

- Fetch the tree: `const { data, isPending } = useEndpoint(getPluginTree, {})`.
- Build `byHierarchyId` from `useConfigRegistrations()`.
- `const tree = useMemo(() => pruneConfigTree(data?.plugins ?? [], byHierarchyId), …)`.
- Render `ConfigTreeNode` for each pruned root (replaces the `ConfigNavGroup`
  map). Expansion state set: seed from the pruned tree's group ids (same
  pattern as today's `collectGroupIds`).
- **Keep unchanged**: the search box + "Modified" filter chip and the *flat*
  list mode (`useFlat`) — that mode already renders `ConfigNavRow` directly from
  `filtered` registrations and does not depend on the tree shape.
- Loading: show a `Placeholder` ("Loading…") while `isPending` in tree mode.

### 4. `config-nav-row.tsx`

Keep it (used by flat search/modified mode). Refactor its internals to use the
new `useConfigRowState` hook. No behavior change.

### 5. Detail pane / panes / endpoints

No changes. `configDetailPane`, `ConfigDetail`, and all server endpoints stay
exactly as they are.

### 6. Plugin dependencies

`plugins/config_v2/plugins/settings` gains cross-plugin imports from
`@plugins/plugin-meta/plugins/plugin-view/core` and
`@plugins/infra/plugins/endpoints/web`. Add both to the settings plugin's
`package.json` dependencies (bun workspace resolution) — mirror how an existing
consumer (e.g. `forge/catalog`) declares them. These are legal runtime-barrel
imports under the boundary rules.

## Files

| File | Change |
|---|---|
| `…/settings/web/internal/build-config-tree.ts` | **delete** |
| `…/settings/web/internal/prune-config-tree.ts` | **new** — pruning + `ConfigTreeNode` type |
| `…/settings/web/components/config-tree-node.tsx` | **new** — unified recursive row |
| `…/settings/web/components/config-nav.tsx` | rewrite tree mode to fetch + prune + render canonical tree; keep flat mode |
| `…/settings/web/components/config-nav-row.tsx` | refactor to use shared `useConfigRowState` |
| `…/settings/web/internal/use-config-row-state.ts` | **new** — shared modified-count/conflict hook (optional small file) |
| `…/settings/package.json` | add `plugin-view` + `endpoints` deps |

Reused, not rebuilt: `getPluginTree` + `PluginNode`/`PluginTreePayload`
(`@plugins/plugin-meta/plugins/plugin-view/core`), `useEndpoint`
(`@plugins/infra/plugins/endpoints/web`), `Collapsible*`
(`@plugins/primitives/plugins/collapsible/web`), `useConfigRegistrations` /
`useConfig` (`@plugins/config_v2/web`), `Placeholder`
(`@plugins/primitives/plugins/placeholder/web`).

## Verification

1. `./equin build` (from the worktree). Confirm it compiles and the
   `eslint` / boundary checks pass (the new cross-plugin imports must be legal).
2. Open `http://att-1780406317-z5hj.localhost:9000`, go to the **Config**
   sidebar entry.
3. Scripted Playwright check (`bun e2e/screenshot.mjs`) on the Config pane:
   - The tree shows the canonical hierarchy pruned to config-bearing branches
     (e.g. `conversations › conversation-view › launch-prompts`, `backup` with
     `google-drive` / `local` nested under it). No configless plugins appear.
   - Clicking a config-bearing node opens its fields in the right detail pane
     (`--click` a leaf, assert detail renders).
   - A node that has both its own config and children (`backup`) is both
     clickable and expandable.
   - The search box filters and the "Modified" chip still switches to the flat
     list.
4. Sanity: no `console.warn` about unmatched registrations (all should map to a
   tree node).

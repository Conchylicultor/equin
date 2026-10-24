# Facets v3 Phase 3 — `cross-refs` render sub-plugins (diff/detail/catalog)

## Context

The facets v3 migration (`research/2026-06-02-global-facets-rendering-separation-v3.md`)
separates each facet's browser rendering into three sub-plugins
(`render-diff` / `render-detail` / `render-catalog`) so that "adding a facet =
adding one folder subtree, touching no consumer." Phase 2 proved the slice on
`exports`; the most recent commit (`a8f2a4c4c`) replicated it for
`contributions`. Both are complete reference templates.

The **`cross-refs`** facet has not yet been migrated. Its rendering still lives in
consumers: the `ImportedByBanner` in
`plugin-view/.../public-api/web/components/public-api-section.tsx` renders
`importedBy`, and `apiUseStrings()` in `compute-plugin-diff.ts:69-78` computes its
diff projection. There is no catalog tab for it today.

This plan builds cross-refs' three browser renderers, mirroring the
`contributions` slice byte-for-byte in shape, and moves its `toComparable`
projection into `core/`. **Consumers are NOT touched here** — wiring the hosts to
iterate these contributions generically is Phase 4. As with the existing
`exports`/`contributions` render sub-plugins, the new contributions register but
stay dormant until Phase 4 flips the hosts.

The cross-refs facet data shape (`cross-refs/core/types.ts`):

```ts
type Runtime = "server" | "central" | "web" | "core" | "shared";
interface CrossRefsData {
  apiUses: Record<Runtime, string[]>; // forward: what this plugin imports, per runtime
  importedBy: string[];               // reverse index: who imports this plugin
}
```

## Design decisions (confirmed)

- **D1 — render-detail shows BOTH datasets.** A per-runtime "Uses" group (from
  `apiUses`) plus the `Imported by` banner (from `importedBy`). Matches `renderDoc`
  (which emits both) and the exports/contributions precedent of rendering the full
  facet data. This surfaces `apiUses` in the detail pane for the first time (today
  only `importedBy` shows).
- **D2 — render-catalog rows are forward "Uses" edges.** One row per
  `(plugin, used)` from `apiUses` — the authored data. `importedBy` is derived from
  it, so forward edges avoid double-representation. Columns: `Uses` | `Runtime` |
  `Plugin`.
- **D3 — `toComparable` = deduped union of `apiUses` across all runtimes.** Mirrors
  the legacy `apiUseStrings()` (`compute-plugin-diff.ts:69-78`), which dedups the
  union of `server/central/web/core` apiUses. We iterate all 5 runtimes; `shared` is
  empty in practice (cross-plugin imports from `shared/` are forbidden by R10), so
  output is behaviorally identical. `importedBy` is excluded — it is a derived
  reverse index that changes based on *other* plugins, so it does not belong in a
  per-plugin diff. Diff label: **"Uses"** (matches the `renderDoc` key).

## Files to create

All under `plugins/plugin-meta/plugins/facets/plugins/cross-refs/`.

### 1. `core/to-comparable.ts` (NEW)

Mirror `contributions/core/to-comparable.ts`. Pure projection, runtime-agnostic.

```ts
import type { CrossRefsData } from "./types";

const RUNTIMES = ["server", "central", "web", "core", "shared"] as const;

/** Diff projection: the deduped union of apiUses across all runtimes.
 *  Mirrors the legacy apiUseStrings() (compute-plugin-diff.ts). importedBy is a
 *  derived reverse index, so it is intentionally excluded from the diff. */
export function crossRefsToComparable(data: CrossRefsData): string[] {
  const uses = new Set<string>();
  for (const rt of RUNTIMES) for (const u of data.apiUses[rt]) uses.add(u);
  return [...uses];
}
```

### 2. `core/index.ts` (EDIT)

Add the projection to the existing barrel (currently only re-exports the def +
type):

```ts
export { crossRefsFacetDef } from "./types";
export type { CrossRefsData } from "./types";
export { crossRefsToComparable } from "./to-comparable";
```

### 3. `plugins/render-diff/` (NEW)

- `package.json` — mirror `contributions/plugins/render-diff/package.json`
  (`"name": "@singularity/plugin-plugin-meta-facets-cross-refs-render-diff"`,
  `description`).
- `CLAUDE.md` — prose only; the `## Plugin reference` AUTOGEN block is inserted by
  `./equin build` (do not hand-write it).
- `web/index.ts`:

```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { PluginChangesSlots } from "@plugins/review/plugins/plugin-changes/web";
import {
  crossRefsToComparable,
  type CrossRefsData,
} from "@plugins/plugin-meta/plugins/facets/plugins/cross-refs/core";

export default {
  name: "Cross-refs: Diff Renderer",
  description: "Diff renderer for the cross-refs facet (PR review).",
  contributions: [
    PluginChangesSlots.DiffRenderer({
      facetId: "cross-refs",
      label: "Uses",
      toComparable: (data) => crossRefsToComparable(data as CrossRefsData),
    }),
  ],
} satisfies PluginDefinition;
```

### 4. `plugins/render-detail/` (NEW)

- `package.json`, `CLAUDE.md` — mirror contributions.
- `web/index.ts` — contributes `PluginViewSlots.Section({ id: "cross-refs", label:
  "Cross-refs", component: CrossRefsDetailSection })`.
- `web/components/cross-refs-detail-section.tsx` — reads
  `node.facets?.["cross-refs"] as CrossRefsData | undefined`; returns `null` when
  absent or empty. Renders:
  - A per-runtime **"Uses"** group: for each runtime with `apiUses[rt].length > 0`,
    a `SubHeading`/grouped list of `code`-formatted symbol names, runtime label
    colored via `RUNTIME_COLORS[rt]` (from `plugin-view/web`).
  - The **Imported by** banner: port `ImportedByBanner` (the +N-more expandable
    `PluginLink` list) from `public-api-section.tsx:97-122` into this component.
  - Wrap in the shared `Section` (from `plugin-view/web`) with a count summary
    (e.g. `${totalUses} use(s) · ${importedBy.length} importer(s)`), following the
    contributions detail section's `Section` usage.

  Reuses `Section`, `SubHeading`, `PluginLink`, `RUNTIME_COLORS`, `type PluginNode`
  from `@plugins/plugin-meta/plugins/plugin-view/web`. Use a module-local
  `CROSS_REFS_FACET_ID = "cross-refs"` and a type-only import of `CrossRefsData`
  from the facet core (erased — does not pull `loadFacets`/`fs` into the bundle),
  exactly as `contributions-detail-section.tsx` does.

### 5. `plugins/render-catalog/` (NEW)

- `package.json`, `CLAUDE.md` — mirror contributions.
- `web/index.ts` — `contributions: [Catalog.FacetTable(crossRefsFacetTable)]`.
- `web/cross-refs-facet-table.tsx` — `defineFacetTable<CrossRefRow>` mirroring
  `contributions-facet-table.tsx`:

```ts
type CrossRefRow = { plugin: PluginNode; used: string; runtime: string };
```

  - Columns: `Uses` (`row.used`, mono, flex-1) | `Runtime` (`row.runtime`,
    muted) | `Plugin` (`<PluginChip hierarchyId={row.plugin.hierarchyId} />`).
  - `rows(entries)`: for each entry, for each runtime, for each `used` in
    `data.apiUses[rt]` → push `{ plugin: entry.node, used, runtime: rt }`.
  - `facetId: "cross-refs"`, `label: "Cross-refs"`, `icon` from `react-icons/md`
    (e.g. `MdCallSplit` / `MdShare`), `rowKey: (r) =>
    \`${r.plugin.hierarchyId}:${r.runtime}:${r.used}\``.

  Imports `defineFacetTable`, `FacetTableEntry`, `PluginChip` from
  `@plugins/apps/plugins/forge/plugins/catalog/web`; `ColumnDef` from
  `data-table/web`; `PluginNode` from `plugin-view/core`; `CrossRefsData` (type-only)
  from the facet core.

## Reference templates (copy shape exactly — "mirror working precedent")

| New file | Mirror |
|---|---|
| `cross-refs/core/to-comparable.ts` | `contributions/core/to-comparable.ts` |
| `render-diff/web/index.ts` | `contributions/plugins/render-diff/web/index.ts` |
| `render-detail/web/index.ts` + component | `contributions/plugins/render-detail/...` |
| `render-catalog/web/index.ts` + table | `contributions/plugins/render-catalog/...` |
| `ImportedByBanner` source to port | `public-api-section.tsx:97-122` |
| legacy diff projection to match | `compute-plugin-diff.ts:69-78` (`apiUseStrings`) |

## Constraints / conventions

- **No authored plugin `id:`** in barrels — loader-derived from path.
- **Barrel purity** — `web/index.ts` files contain only imports + a single
  `export default {…} satisfies PluginDefinition`. Components live under
  `web/components/` (detail) or `web/<name>-facet-table.tsx` (catalog), matching
  contributions' layout.
- **No cross-plugin import from facet `shared/`**; consumers read
  `node.facets["cross-refs"]` and import only the facet `core/` (type-only) +
  generic host barrels (`plugin-view/web`, `catalog/web`, `plugin-changes/web`).
- **CLAUDE.md** — write prose only; `./equin build` codegen inserts the
  `## Plugin reference` AUTOGEN block.
- Tailwind: no arbitrary font sizes (`text-[10px]` → `text-3xs`).

## Verification

1. `./equin build` — succeeds; codegen populates the three new CLAUDE.md
   AUTOGEN blocks and updates `facets/CLAUDE.md` sub-plugin list + `docs/*.md`.
2. `./equin check` — passes (boundaries, eslint, plugins-doc-in-sync).
3. Confirm registration: the cross-refs `DiffRenderer`, `PluginView.Section`, and
   `Catalog.FacetTable` contributions appear (e.g. grep the autogen docs /
   `facets/CLAUDE.md` now lists `render-catalog`/`render-detail`/`render-diff`
   under `cross-refs`, matching `exports`/`contributions`).
4. Visual (dormant until Phase 4 wires hosts, but the catalog tab is slot-driven
   and should appear immediately): open
   `http://<worktree>.localhost:9000/forge` catalog → a new **Cross-refs** tab
   lists forward "Uses" edges. Capture with `e2e/screenshot.mjs` if confirming.
   The detail-pane section and PR-diff renderer remain inert until Phase 4 flips
   `tree-handler`/`compute-plugin-diff` to generic iteration — that is expected
   and out of scope here.

## Out of scope (later phases)

- Phase 4: flip `compute-plugin-diff.ts` to send raw `node.facets` + iterate
  `DiffRenderer`s (deletes `apiUseStrings`), flip `tree-handler`/catalog to generic
  iteration, delete `public-api` plugin + `ImportedByBanner`.
- Phase 5: the completeness check asserting every facet has all three renderers.
- Phase 6: compat-shim cleanup.

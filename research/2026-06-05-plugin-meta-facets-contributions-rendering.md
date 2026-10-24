# Facets v3 Phase 3 — contributions facet rendering sub-plugins

## Context

The facets v3 migration (`research/2026-06-02-global-facets-rendering-separation-v3.md`)
moves per-facet rendering for the **diff**, **detail**, and **catalog** surfaces out of
the consumers and into three browser sub-plugins under each facet, so that "adding a
facet = adding one folder subtree, touching no consumer". Phase 2 proved the pattern on
the `exports` facet; the `slots` facet followed (commit `738d55116`). The `contributions`
facet still has **no** render sub-plugins — its rendering lives in consumers
(`compute-plugin-diff.ts`'s `contributionStrings()`, and the catalog's hardcoded
`ContributionsTable`). This task builds the three render sub-plugins for `contributions`,
mirroring the `exports`/`slots` reference slices byte-for-byte, and moves the diff
projection (`toComparable`) into the facet's `core/`.

This is purely additive: it creates new sub-plugins. The consumers are NOT yet deleted
(that is Phase 4). The new web plugins are auto-discovered by folder and codegen
regenerates `web.generated.ts` — no registry edits.

## Data shape (reference)

`ContributionsFacetData` (`facets/plugins/contributions/core/types.ts`):
```ts
interface Contribution { slot: string; props: Record<string,string>; paneId?: string; panePath?: string; }
interface DocMetaContribution { slotId: string; slotDisplayName?: string; componentName?: string; doc: DocMeta; }
interface ContributionsFacetData {
  static: Contribution[];          // parsed statically — always present in the browser
  runtime: DocMetaContribution[];  // barrel-import only — empty under skipBarrelImport (browser)
  slotContributors: string[];      // computed by relate() — who contributes to this plugin's slots
}
```
The browser-reliable data is `static` + `slotContributors`. The existing diff/catalog
consumers project the `static` contributions as `slot "id"`, where
`id = paneId ?? stripQuotes(props["id"])` (see `contributionStrings()` at
`compute-plugin-diff.ts:43-48`).

## Implementation

All paths under `plugins/plugin-meta/plugins/facets/plugins/contributions/`.

### 1. `core/` — add the pure projection (shared by diff + catalog + detail)

**NEW `core/to-comparable.ts`** — port `contributionStrings()` and factor the id helper:
```ts
import type { Contribution, ContributionsFacetData } from "./types";

// Derives a contribution's display id, mirroring compute-plugin-diff.ts's
// contributionStrings(): prefer the resolved paneId, else the quote-stripped `id` prop.
export function contributionId(c: Contribution): string | undefined {
  const raw = c.paneId ?? c.props["id"]?.replace(/^["'`]|["'`]$/g, "");
  return raw || undefined;
}

export function contributionsToComparable(data: ContributionsFacetData): string[] {
  return data.static.map((c) => {
    const id = contributionId(c);
    return id ? `${c.slot} "${id}"` : c.slot;
  });
}
```

**EDIT `core/index.ts`** — add the two value exports (keep existing type exports):
```ts
export { contributionsFacetDef } from "./types";
export type { Contribution, ContributionsFacetData, DocMetaContribution } from "./types";
export { contributionId, contributionsToComparable } from "./to-comparable";
```

### 2. `plugins/render-diff/web` — `DiffRenderer` contribution

**NEW `plugins/render-diff/package.json`** (mirror slots):
```json
{ "name": "@singularity/plugin-plugin-meta-facets-contributions-render-diff",
  "version": "0.0.1", "private": true,
  "description": "Diff renderer for the contributions facet (PR review)." }
```
**NEW `plugins/render-diff/web/index.ts`** (mirror `slots/.../render-diff/web/index.ts`):
```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { PluginChangesSlots } from "@plugins/review/plugins/plugin-changes/web";
import {
  contributionsToComparable,
  type ContributionsFacetData,
} from "@plugins/plugin-meta/plugins/facets/plugins/contributions/core";

export default {
  name: "Contributions: Diff Renderer",
  description: "Diff renderer for the contributions facet (PR review).",
  contributions: [
    PluginChangesSlots.DiffRenderer({
      facetId: "contributions",
      label: "Contributions",
      toComparable: (data) => contributionsToComparable(data as ContributionsFacetData),
    }),
  ],
} satisfies PluginDefinition;
```
**NEW `plugins/render-diff/CLAUDE.md`** — prose header; `## Plugin reference` block filled by build.

### 3. `plugins/render-detail/web` — `PluginView.Section` (contributions + slot contributors)

**NEW `plugins/render-detail/package.json`**:
```json
{ "name": "@singularity/plugin-plugin-meta-facets-contributions-render-detail",
  "description": "Per-plugin contributions section in the plugin detail pane.",
  "private": true, "version": "0.0.1" }
```
**NEW `plugins/render-detail/web/index.ts`** (mirror slots):
```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { PluginViewSlots } from "@plugins/plugin-meta/plugins/plugin-view/web";
import { ContributionsDetailSection } from "./components/contributions-detail-section";

export default {
  name: "Contributions: Detail Section",
  description: "Per-plugin contributions section in the plugin detail pane.",
  contributions: [
    PluginViewSlots.Section({
      id: "contributions",
      label: "Contributions",
      component: ContributionsDetailSection,
    }),
  ],
} satisfies PluginDefinition;
```
**NEW `plugins/render-detail/web/components/contributions-detail-section.tsx`** — renders
**two blocks** (per the chosen design): the plugin's own `static` contributions (slot + id),
and the `slotContributors` (reusing `ConsumerList` from `plugin-view/web`, as the exports
detail does). Reads `node.facets["contributions"]` directly (never imports the build-time
`facets/core` barrel; type-only import is erased). Returns `null` when both are empty.
```tsx
import {
  Section,
  ConsumerList,
  type PluginNode,
} from "@plugins/plugin-meta/plugins/plugin-view/web";
import {
  contributionId,
  type ContributionsFacetData,
} from "@plugins/plugin-meta/plugins/facets/plugins/contributions/core";

const CONTRIBUTIONS_FACET_ID = "contributions";

export function ContributionsDetailSection({ node }: { node: PluginNode }) {
  const data = node.facets?.[CONTRIBUTIONS_FACET_ID] as ContributionsFacetData | undefined;
  if (!data) return null;
  const { static: contribs, slotContributors } = data;
  if (contribs.length === 0 && slotContributors.length === 0) return null;

  return (
    <Section title="Contributions" count={`${contribs.length} contribution${contribs.length !== 1 ? "s" : ""}`}>
      {contribs.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {contribs.map((c, i) => {
            const id = contributionId(c);
            return (
              <div key={`${c.slot}:${id ?? i}`} className="flex items-center gap-2 px-2 py-0.5 text-xs">
                <code className="font-mono text-foreground">{c.slot}</code>
                {id && <code className="ml-auto truncate font-mono text-muted-foreground/60">{id}</code>}
              </div>
            );
          })}
        </div>
      )}
      {slotContributors.length > 0 && (
        <div className="mt-2 flex items-center gap-2 px-2 text-xs">
          <span className="text-muted-foreground/60">Slot contributors</span>
          <ConsumerList names={slotContributors} />
        </div>
      )}
    </Section>
  );
}
```
> Exact class names / `ConsumerList` usage will be adjusted to match the live precedent
> when implementing (verify `ConsumerList`'s prop name against `exports-detail-section.tsx`).

**NEW `plugins/render-detail/CLAUDE.md`** — prose header; reference block filled by build.

### 4. `plugins/render-catalog/web` — `Catalog.FacetTable`

**NEW `plugins/render-catalog/package.json`**:
```json
{ "name": "@singularity/plugin-plugin-meta-facets-contributions-render-catalog",
  "description": "Aggregated cross-plugin contributions table in the Forge catalog.",
  "private": true, "version": "0.0.1" }
```
**NEW `plugins/render-catalog/web/index.ts`** (mirror slots):
```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Catalog } from "@plugins/apps/plugins/forge/plugins/catalog/web";
import { contributionsFacetTable } from "./contributions-facet-table";

export default {
  name: "Contributions: Catalog Table",
  description: "Aggregated cross-plugin contributions table in the Forge catalog.",
  contributions: [Catalog.FacetTable(contributionsFacetTable)],
} satisfies PluginDefinition;
```
**NEW `plugins/render-catalog/web/contributions-facet-table.tsx`** (mirror
`slots-facet-table.tsx`; columns Slot | ID | Plugin, matching the legacy `ContributionsTable`).
Uses `MdLayers` (same icon the legacy contributions category used). Rows iterate
`entry.data.static`, projecting `id = contributionId(c)`:
```tsx
import { defineFacetTable, type FacetTableEntry, PluginChip } from "@plugins/apps/plugins/forge/plugins/catalog/web";
import type { ColumnDef } from "@plugins/primitives/plugins/data-table/web";
import type { PluginNode } from "@plugins/plugin-meta/plugins/plugin-view/core";
import { contributionId, type ContributionsFacetData } from "@plugins/plugin-meta/plugins/facets/plugins/contributions/core";
import { MdLayers } from "react-icons/md";

type ContributionRow = { plugin: PluginNode; slot: string; id?: string };
// columns: slot (w-48 shrink-0), id (flex-1 min-w-0, "—" when absent), plugin (<PluginChip/>)
function rows(entries: FacetTableEntry[]): ContributionRow[] {
  const result: ContributionRow[] = [];
  for (const entry of entries) {
    const data = entry.data as ContributionsFacetData;
    for (const c of data.static) result.push({ plugin: entry.node, slot: c.slot, id: contributionId(c) });
  }
  return result;
}
export const contributionsFacetTable = defineFacetTable<ContributionRow>({
  facetId: "contributions", label: "Contributions", icon: MdLayers,
  columns, rows, rowKey: (r) => `${r.plugin.hierarchyId}:${r.slot}:${r.id ?? ""}`,
});
```
**NEW `plugins/render-catalog/CLAUDE.md`** — prose header; reference block filled by build.

### 5. Parent docs

**EDIT `plugins/.../contributions/CLAUDE.md`** — add the same "Browser rendering lives in
the render-diff / render-detail / render-catalog sub-plugins…" prose paragraph that the
`slots` facet CLAUDE.md carries. The `## Plugin reference` autogen block (sub-plugin list,
new core exports) is regenerated by `./equin build`.

## Notes / invariants honored

- No consumer is edited (Phase 4 deletes the legacy `contributionStrings()` and
  `ContributionsTable`); this phase only adds the producers. Two renderers temporarily
  coexist with the legacy code paths — acceptable and intended by the phased plan.
- Render sub-plugins import only their parent facet's `core/` (allowed — same subtree,
  public barrel) and the host slot barrels (`plugin-changes/web`, `plugin-view/web`,
  `catalog/web`). No cross-facet imports; no `facets/core` in the browser bundle.
- Registration is automatic: `web.generated.ts` regenerates from the filesystem on build
  (`plugins-registry-in-sync` check guards drift).

## Critical files

| File | Action |
|---|---|
| `contributions/core/to-comparable.ts` | NEW — `contributionId`, `contributionsToComparable` |
| `contributions/core/index.ts` | EDIT — export the two new values |
| `contributions/plugins/render-diff/{package.json,web/index.ts,CLAUDE.md}` | NEW |
| `contributions/plugins/render-detail/{package.json,web/index.ts,CLAUDE.md}` + `web/components/contributions-detail-section.tsx` | NEW |
| `contributions/plugins/render-catalog/{package.json,web/index.ts,CLAUDE.md}` + `web/contributions-facet-table.tsx` | NEW |
| `contributions/CLAUDE.md` | EDIT — render sub-plugins prose |

Reference files to mirror byte-for-byte:
`facets/plugins/slots/plugins/{render-diff,render-detail,render-catalog}/` and
`facets/plugins/exports/plugins/render-detail/web/components/exports-detail-section.tsx`
(for `ConsumerList` usage).

## Verification

1. `./equin build` — succeeds; regenerates `web.generated.ts` (3 new entries) and the
   CLAUDE.md `## Plugin reference` blocks.
2. `./equin check` — passes (`plugins-registry-in-sync`, `plugins-doc-in-sync`,
   `eslint`, `--plugin-boundaries`).
3. Forge catalog (`http://<worktree>.localhost:9000`, Forge app → Catalog) shows a
   **Contributions** facet-table tab with slot / id / plugin rows. (The legacy
   `ContributionsTable` category may still appear until Phase 4 — both reading the same
   data is expected.)
4. Forge plugin detail pane for a plugin with contributions shows the new **Contributions**
   section (contributions list + slot contributors). Verify via
   `bun e2e/screenshot.mjs` on a plugin-view pane.
5. `docs/*.md` byte-identical (this phase adds no doc-rendering changes; `renderDoc` is
   untouched).

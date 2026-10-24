# Contributions Facet

## Context

`enrichPluginTreeDocs()` in `plugin-tree.ts` runs a monolithic Pass 2 that imports all plugin barrels and extracts `def.contributions[]` into `node.runtimeContributions: DocMetaContribution[]`. This is the runtime-enriched contributions view — slot ID, display name resolved from the slot runtime object, component name from the live function, and DocMeta.

This task migrates that extraction into a self-contained `contributions` facet (Step 3 of the unified facet pipeline described in `research/2026-05-20-global-unified-facet-docgen.md`). The facet dual-writes into `node.facets["contributions"]` alongside the still-populated monolithic `node.runtimeContributions`. Docgen continues reading the monolithic field unchanged until Step 5.

The key challenge is `slotDisplayName`: Pass 2 resolves it from a global `slotDisplayNames` Map built during barrel import (not available in `ExtractContext`). The solution: `relate()` reconstructs the map from the `slots` facet data (already extracted for all nodes before `relate()` runs), which gives the same `groupName.memberName` display string.

## Files to Create

### `plugins/plugin-meta/plugins/facets/plugins/contributions/CLAUDE.md`

```markdown
# contributions

Extracts runtime slot contributions from each plugin's barrel imports. Reads
`def.contributions[]` from the module default export across all runtimes (in
practice only web barrels carry contributions).

`extract()` collects `{ slotId, componentName, doc }` without display names.
`relate()` fills in `slotDisplayName` by reading the `slots` facet across all
nodes — `${groupName}.${memberName}` from each `SlotDef`.

`renderDoc()` is implemented but not yet called (docgen still reads the monolithic
`node.runtimeContributions` until Step 5).

## Plugin reference
```

### `plugins/plugin-meta/plugins/facets/plugins/contributions/facet/index.ts`

```typescript
import type { DocMetaContribution, PluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import {
  createFacet,
  defineFacet,
  getFacet,
  type ExtractContext,
  type RenderDocContext,
} from "@plugins/plugin-meta/plugins/facets/core";
import { slotsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/slots/facet";

export const contributionsFacetDef = defineFacet<DocMetaContribution[]>("contributions");

export default createFacet<DocMetaContribution[]>({
  def: contributionsFacetDef,

  extract(ctx: ExtractContext): DocMetaContribution[] {
    const { importedModules } = ctx;
    if (!importedModules || importedModules.length === 0) return [];

    const contributions: DocMetaContribution[] = [];
    for (const { mod } of importedModules) {
      let def: Record<string, unknown> | undefined;
      try {
        def = mod.default as Record<string, unknown> | undefined;
      } catch {
        continue;
      }
      if (!def) continue;

      const rawContributions = def.contributions as
        | Array<Record<string, unknown> & { _slotId?: string; _doc?: { label?: string; detail?: string } }>
        | undefined;
      if (!rawContributions) continue;

      for (const c of rawContributions) {
        if (!c._slotId) continue;
        const comp = c.component;
        const componentName =
          typeof comp === "function" && comp.name ? (comp.name as string) : undefined;
        contributions.push({
          slotId: c._slotId,
          // slotDisplayName filled in by relate()
          componentName,
          doc: c._doc ?? {},
        });
      }
    }
    return contributions;
  },

  relate(rawCtx) {
    const { tree } = rawCtx as { tree: PluginTree };

    // Build slotId → displayName from slots facet (already extracted across all nodes)
    const slotDisplayNames = new Map<string, string>();
    for (const node of tree.byDir.values()) {
      const slots = getFacet(node, slotsFacetDef) ?? [];
      for (const s of slots) {
        if (!slotDisplayNames.has(s.slotId)) {
          slotDisplayNames.set(s.slotId, `${s.groupName}.${s.memberName}`);
        }
      }
    }

    // Fill display names into already-extracted contribution data
    for (const node of tree.byDir.values()) {
      const contribs = getFacet(node, contributionsFacetDef);
      if (!contribs || contribs.length === 0) continue;
      for (const c of contribs) {
        if (!c.slotDisplayName) {
          c.slotDisplayName = slotDisplayNames.get(c.slotId);
        }
      }
    }
  },

  renderDoc(data: DocMetaContribution[], ctx: RenderDocContext): string[] {
    if (data.length === 0) return [];
    const indent = `${ctx.bodyIndent}  `;
    const subIndent = `${ctx.bodyIndent}    `;
    const lines: string[] = [`${indent}- Contributes:`];
    for (const c of data) {
      const parts = [`\`${c.slotDisplayName ?? c.slotId}\``];
      if (c.doc.label) parts.push(`"${c.doc.label}"`);
      if (c.doc.detail) parts.push(`(${c.doc.detail})`);
      if (c.componentName) parts.push(`→ \`${c.componentName}\``);
      lines.push(`${subIndent}- ${parts.join(" ")}`);
    }
    return lines;
  },
});
```

## Design Notes

**All runtimes, no filter**: Pass 2 in `plugin-tree.ts` reads `def.contributions` from all runtimes without filtering. The facet mirrors this. In practice only web barrels carry contributions, but the facet is defensive.

**`relate()` ordering is safe**: `loadFacets()` discovers facets alphabetically — `contributions` sorts before `slots`. But `relate()` runs after ALL `extract()` passes complete, so `slotsFacetDef` data is always populated when `contributions.relate()` runs.

**`slotDisplayName` coverage**: The `slots` facet parses `web/slots.ts` via `parseDefineGroup("defineSlot")`. The monolithic `slotDisplayNames` reads slot-like exports from barrel imports. Both should find the same slots for conventionally structured plugins. Slots not in a `slots.ts` (e.g. framework-level web-sdk slots) will fall back to `slotId` in `renderDoc` — same fallback as the current docgen.ts `c.slotDisplayName ?? c.slotId`.

**`renderDoc` indentation**: `- Contributes:` at `bodyIndent + "  "` (same level as other facets' single-line bullets), per-slot items at `bodyIndent + "    "`. When docgen.ts is migrated at Step 5, `ctx.bodyIndent` will match the current `bodyIndent` variable in `renderPluginBody()`, so `bodyIndent + "  " = subIndent` from the current docgen output.

**No manual registry edit**: `./equin build` auto-populates `facet.generated.ts`.

## Critical Files

| File | Role |
|------|------|
| `plugins/plugin-meta/plugins/facets/plugins/registrations/facet/index.ts` | Reference implementation (uses `importedModules`) |
| `plugins/plugin-meta/plugins/facets/plugins/slots/facet/index.ts` | Source of `slotsFacetDef` for `relate()` |
| `plugins/plugin-meta/plugins/facets/core/facets.ts` | `ExtractContext`, `createFacet`, `getFacet` |
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` | Pass 2 logic to replicate; `DocMetaContribution` type |
| `plugins/framework/plugins/tooling/plugins/codegen/core/docgen.ts` | `renderDoc` output to match at Step 5 |

## Verification

1. `./equin build` succeeds — `facet.generated.ts` gains a `contributions` entry; TypeScript compiles cleanly.
2. `diff docs/plugins-compact.md` and `docs/plugins-details.md` vs pre-change snapshots — byte-identical (docgen still reads `node.runtimeContributions`).
3. `./equin check` passes all checks.
4. Spot-check: a plugin with contributions (e.g. `shell.toaster` → `Shell.Toast`) should have `facets.contributions` populated with correct `slotId`, `slotDisplayName`, and `doc` fields.

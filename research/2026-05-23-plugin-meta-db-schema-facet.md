# db-schema Facet

## Context

DB schema metadata — schema file paths, table definitions, entity extensions, and `extendedBy` cross-references — is still extracted monolithically in `plugin-tree.ts` (functions `findDbFiles`, `parseTableNamesFromDbFiles`, `parseEntityExtensionCalls`, and the db-schema block of `computeRelationships()`). This is Step 3 of the unified facet-based docgen plan (see `research/2026-05-20-global-unified-facet-docgen.md`).

The goal is to create a self-contained `db-schema` facet that:
1. Extracts per-plugin DB schema data during the extract pass
2. Wires cross-plugin `entityExtensions` / `extendedBy` references during the relate pass
3. Provides a `renderDoc()` implementation ready for when docgen migrates to facets (Step 5)

**This is a dual-write step**: monolithic fields (`node.dbFiles`, `node.tables`, `node.entityExtensions`, `node.extendedBy`) continue to be populated by the existing code. Doc output must remain byte-identical.

---

## Implementation

### 1. Create the facet file

**New file**: `plugins/plugin-meta/plugins/facets/plugins/db-schema/facet/index.ts`

The facet is fully self-contained — no changes needed to `plugin-tree/core/index.ts`. Import from already-exported helpers:
- `readIfExists`, `stripTypes` from `@plugins/plugin-meta/plugins/plugin-tree/core`
- Types `EntityExtension`, `EntityExtensionRef`, `TableDef`, `PluginTree` from `@plugins/plugin-meta/plugins/plugin-tree/core`
- `createFacet`, `defineFacet`, `getFacet` from `@plugins/plugin-meta/plugins/facets/core`

Inline the DB-specific helpers (copied from `plugin-tree.ts`, not re-exported to keep the barrel lean):
- `parseImports(src)` — parses `import … from "…"` statements into `Map<localName, { original, module }>` (~30 lines)
- `findDbFiles(pluginDir)` — walks `<dir>/server/**`, collects `.ts` files matching `schema`/`tables?` by name or containing `pgTable(`/`pgView(` (~25 lines)
- `parseTableNamesFromDbFiles(dbFiles)` — regex-scans for `const X = pgTable('name'` → `Map<varName, tableName>` (~15 lines)
- `parseEntityExtensionCalls(dbFiles)` — regex-scans for `defineExtension(importedVar, "extName")`, resolves imports → `{ parentVarName, parentModule, extName }[]` (~20 lines)

**Data type**:
```typescript
export interface DbSchemaFacetData {
  dbFiles: string[];              // absolute paths — populated in extract
  tables: TableDef[];             // populated in extract
  entityExtensions: EntityExtension[];  // populated in relate
  extendedBy: EntityExtensionRef[];     // populated in relate
}
```

**`extract(ctx)`**: 
```typescript
const dbFiles = findDbFiles(ctx.dir);
const tableMap = parseTableNamesFromDbFiles(dbFiles);
const tables = [...tableMap.entries()].map(([varName, name]) => ({ name, varName }));
return { dbFiles, tables, entityExtensions: [], extendedBy: [] };
```

**`relate(rawCtx)`**:
```typescript
const { tree } = rawCtx as { tree: PluginTree };
const byName = new Map<string, Node>();
for (const node of tree.byDir.values()) byName.set(node.name, node);

// Build plugin-name → varName→tableName map from already-extracted facet data
const pluginVarToTable = new Map<string, Map<string, string>>();
for (const node of tree.byDir.values()) {
  const d = getFacet(node, dbSchemaFacetDef);
  if (!d) continue;
  const m = new Map<string, string>();
  for (const t of d.tables) m.set(t.varName, t.name);
  pluginVarToTable.set(node.name, m);
}

const pluginModuleRe = /@plugins\/([^/"'`]+)\/(?:server|central|shared|core)/;
for (const node of tree.byDir.values()) {
  const data = getFacet(node, dbSchemaFacetDef);
  if (!data) continue;
  for (const ref of parseEntityExtensionCalls(data.dbFiles)) {
    const pluginMatch = ref.parentModule.match(pluginModuleRe);
    if (!pluginMatch) continue;
    const parentPluginName = pluginMatch[1]!;
    const parentTableName = (pluginVarToTable.get(parentPluginName) ?? new Map()).get(ref.parentVarName) ?? "";
    const tableName = parentTableName
      ? `${parentTableName}_ext_${ref.extName}`
      : `${parentPluginName}_ext_${ref.extName}`;
    if (!data.entityExtensions.some((e) => e.tableName === tableName)) {
      data.entityExtensions.push({ parentPlugin: parentPluginName, extName: ref.extName, tableName });
    }
    const parentNode = byName.get(parentPluginName);
    if (!parentNode) continue;
    const parentData = getFacet(parentNode, dbSchemaFacetDef);
    if (parentData && !parentData.extendedBy.some((e) => e.tableName === tableName)) {
      parentData.extendedBy.push({ childPlugin: node.name, extName: ref.extName, tableName });
    }
  }
}
// Sort for stable output
for (const node of tree.byDir.values()) {
  const d = getFacet(node, dbSchemaFacetDef);
  if (!d) continue;
  d.entityExtensions.sort((a, b) => a.tableName.localeCompare(b.tableName));
  d.extendedBy.sort((a, b) => a.tableName.localeCompare(b.tableName));
}
```

**`renderDoc(data, ctx)`**:
```typescript
// dbFiles and entityExtensions conceptually live under "Defines:" (Step 5 docgen will handle grouping)
// extendedBy is a top-level body item — rendered at bodyIndent for correct future placement
const subIndent = `${ctx.bodyIndent}  `;
const lines: string[] = [];
for (const f of data.dbFiles) {
  lines.push(`${subIndent}- DB schema: \`${relative(REPO_ROOT, f)}\``);
}
for (const ext of data.entityExtensions) {
  lines.push(`${subIndent}- Entity extension of: \`${ext.parentPlugin}\` (table \`${ext.tableName}\`)`);
}
for (const e of data.extendedBy) {
  lines.push(`${ctx.bodyIndent}- Extended by: \`${e.childPlugin}\` (table \`${e.tableName}\`)`);
}
return lines;
```

> Note: `REPO_ROOT` is resolved via `join(import.meta.dirname, "../../../../../../../../../../")` or by climbing from the facet file up to the `plugins/` root. Cross-check how other facets resolve repo root if they need it — or use an absolute-to-relative helper from the ctx.

### 2. Create CLAUDE.md for the new plugin

**New file**: `plugins/plugin-meta/plugins/facets/plugins/db-schema/CLAUDE.md`

Minimal content (the autogen block is added by `./equin build`):
```markdown
# db-schema facet

Extracts DB schema metadata per plugin: schema file paths, table definitions, entity extensions, and `extendedBy` cross-references (the reverse of `entityExtensions`). Part of the unified facet-based docgen pipeline.
```

### 3. Build

```bash
./equin build
```

This:
- Auto-populates `facet.generated.ts` to include `db-schema`
- Runs `enrichPluginTreeDocs()` which calls `loadFacets()` → the new facet's `extract()` and `relate()` run
- Regenerates `docs/plugins-details.md`, `docs/plugins-compact.md` — output must be **byte-identical** (docgen still reads monolithic fields)

---

## Files

| Action | File |
|--------|------|
| **Create** | `plugins/plugin-meta/plugins/facets/plugins/db-schema/facet/index.ts` |
| **Create** | `plugins/plugin-meta/plugins/facets/plugins/db-schema/CLAUDE.md` |
| **Auto-updated by build** | `plugins/plugin-meta/plugins/facets/core/facet.generated.ts` |
| Read-only reference (monolithic source) | `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` |

---

## Key Reference Files

| File | What to copy from |
|------|-------------------|
| `plugins/plugin-meta/plugins/facets/plugins/cross-refs/facet/index.ts` | `relate()` cross-node write pattern; self-contained helper inlining |
| `plugins/plugin-meta/plugins/facets/plugins/routes/facet/index.ts` | relate() structure; imports from plugin-tree/core |
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` | Source for `parseImports`, `findDbFiles`, `parseTableNamesFromDbFiles`, `parseEntityExtensionCalls`, and the db-schema block of `computeRelationships()` (lines ~502–918) |
| `plugins/plugin-meta/plugins/facets/core/index.ts` | `createFacet`, `defineFacet`, `getFacet` |
| `plugins/plugin-meta/plugins/plugin-tree/core/index.ts` | Already-exported types + helpers to import |

---

## Verification

1. `./equin build` succeeds with no TypeScript errors
2. `diff` on `docs/plugins-details.md` and `docs/plugins-compact.md` — **must be empty** (no doc changes)
3. Spot-check 2–3 per-plugin `CLAUDE.md` autogen blocks for plugins with entity extensions (e.g. `toggle`, `agents`) — identical
4. `./equin check` passes all checks
5. Manually verify the facet data is populated: read `node.facets["db-schema"]` for a plugin that has a schema (e.g. `tasks-core`) via the plugin-view API or by adding a temporary debug log

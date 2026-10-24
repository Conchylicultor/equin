# Migrate docgen to facet renderDoc() API

## Context

Docgen (`plugins/framework/plugins/tooling/plugins/codegen/core/docgen.ts`) renders plugin documentation by reading monolithic `PluginNode` fields in a 120-line hardcoded `renderPluginBody()` function. Meanwhile, the facets system (`plugins/plugin-meta/plugins/facets/`) already exists with 9 facets that each have `extract()`, `relate()`, and `renderDoc()` methods — but docgen never calls `renderDoc()`. Instead, a compat shim copies facet data back onto PluginNode fields, and docgen reads those.

The goal: replace the hardcoded `renderPluginBody()` with a generic loop over facets calling `renderDoc()`. After this, docgen becomes facet-agnostic — adding a new facet automatically shows up in docs.

## Design

### `DocFact` — structured, folder-scoped return type for `renderDoc()`

Each facet returns structured facts grouped by folder:

```typescript
interface DocFact {
  folder: string;      // "web", "server", "central", "core", "shared", or "cross-plugin"
  key: string;         // "Slots", "Exports", "Uses", "Routes", "Resources", etc.
  values: string[];    // formatted item strings
}
```

`renderDoc()` returns `DocFact[]`. The aggregator:
1. Collects all facts from all facets
2. Groups by `folder`
3. Each folder group is emitted under a `- <Folder>:` header, with each key as a sub-item

Output structure:

```
- Cross-plugin:
  - Imported by: `shell`, `config`
  - Slot contributors: `theme`, `auth`
  - Extended by: `auto-start` (table `tasks_ext_auto_start`)
- Core:
  - Exports: Types: `Foo`, `Bar`; Values: `baz`
- Web:
  - Slots: `Shell.Sidebar`, `Shell.Toolbar`
  - Exports: Types: `ShellLayout`; Values: `useSidebar`
  - Contributes: `Shell.Sidebar` "nav" → `NavComponent`
  - Uses: `config.useConfig`, `theme.useDarkMode`
- Server:
  - Register: `defineJob('cleanup')`
  - Routes: `GET /api/health`, `WS /ws/notifications`
  - Resources: `healthResource` (live)
  - Exports: Types: `HealthCheck`
  - Uses: `database.getPool`
```

No hardcoded folder names in docgen. The folder grouping emerges from what facets report. Ordering within a folder is facet iteration order (topological sort from `loadFacets()`). No magic `order` numbers.

### What each facet returns

**slots** — `{ folder: "web", key: "Slots", values: ["Shell.Sidebar", ...] }`

**commands** — `{ folder: "web", key: "Commands", values: ["Shell.ToggleSidebar", ...] }`

**exports** — one fact per folder that has exports: `{ folder: "core", key: "Exports", values: ["Types: Foo, Bar", "Values: baz"] }`, etc.

**contributions** — `{ folder: "web", key: "Contributes", values: ["Shell.Sidebar \"nav\" → NavComp", ...] }`; plus `{ folder: "cross-plugin", key: "Slot contributors", values: ["theme", "auth"] }`

**registrations** — per runtime: `{ folder: "server", key: "Register", values: ["defineJob('cleanup')", ...] }`

**cross-refs** — per folder with uses: `{ folder: "server", key: "Uses", values: ["database.getPool", ...] }`; plus `{ folder: "cross-plugin", key: "Imported by", values: ["shell", "config"] }`

**resources** — per runtime: `{ folder: "server", key: "Resources", values: ["healthResource (live)", ...] }`

**routes** — per runtime: `{ folder: "server", key: "Routes", values: ["GET /api/health", "WS /ws/notifications"] }`; plus `{ folder: "cross-plugin", key: "Endpoint callers", values: ["shell", "auth"] }`

**db-schema** — `{ folder: "server", key: "DB schema", values: ["server/schema.ts"] }`; `{ folder: "server", key: "Entity extension of", values: ["tasks (table tasks_ext_auto_start)"] }`; plus `{ folder: "cross-plugin", key: "Extended by", values: ["auto-start (table tasks_ext_auto_start)"] }`

### `RenderDocContext`

```typescript
interface RenderDocContext {
  root: string;          // repo root for relative paths
}
```

No more indent fields — the aggregator handles all formatting. Facets return pure data (key + values), not pre-indented strings.

### Facet interface change

```typescript
interface Facet {
  def: FacetDef<unknown>;
  extract: (ctx: ExtractContext) => unknown;
  relate?: (ctx: unknown) => void;
  renderDoc: (data: unknown, ctx: RenderDocContext) => DocFact[];  // was string[]
}
```

### Aggregation algorithm

```typescript
function renderDocFacts(facts: DocFact[], bodyIndent: string): string[] {
  const subIndent = `${bodyIndent}  `;
  const lines: string[] = [];

  // Group by folder, preserving first-seen order
  const folders = new Map<string, DocFact[]>();
  for (const f of facts) {
    let group = folders.get(f.folder);
    if (!group) { group = []; folders.set(f.folder, group); }
    group.push(f);
  }

  for (const [folder, group] of folders) {
    const content: string[] = [];
    for (const fact of group) {
      if (fact.values.length === 0) continue;
      content.push(`${subIndent}- ${fact.key}: ${fact.values.join(", ")}`);
    }
    if (content.length > 0) {
      lines.push(`${bodyIndent}- ${capitalize(folder)}:`);
      lines.push(...content);
    }
  }

  return lines;
}
```

Note: the exact value formatting (backtick-wrapping, comma-joining vs sub-bullets) is TBD during implementation. The key point is that docgen owns formatting, facets provide structured data.

### Facet data type changes

Two facets need expanded data to hold reverse-index data:

1. **contributions** — add `slotContributors: string[]` to `ContributionsFacetData`
2. **routes** — change from `RouteDef[]` to `RoutesData { routes: RouteDef[], endpointCallers: string[] }`

Their `relate()` methods already compute these; they'll store them in facet data too.

### Storing facets on PluginTree

Add `facets: Facet[]` to `PluginTree` so docgen gets them from the tree without calling `loadFacets()` again.

### `renderRoutesDoc` — out of scope

The `routes.md` document stays as-is, reading compat-shim fields.

## Implementation steps

### Step 1: Update Facet interface and types

**`plugins/plugin-meta/plugins/facets/core/facets.ts`**:
- Add `DocFact` interface
- Simplify `RenderDocContext` to just `{ root: string }`
- Change `renderDoc` return type from `string[]` to `DocFact[]`

**`plugins/plugin-meta/plugins/facets/core/index.ts`**:
- Export `DocFact`

### Step 2: Update facet data types

**`plugins/plugin-meta/plugins/facets/plugins/contributions/core/types.ts`**:
- Add `slotContributors: string[]` to `ContributionsFacetData`

**`plugins/plugin-meta/plugins/facets/plugins/routes/core/types.ts`**:
- Add `RoutesData { routes: RouteDef[], endpointCallers: string[] }`
- Change `routesFacetDef` to `FacetDef<RoutesData>`

**`plugins/plugin-meta/plugins/facets/plugins/routes/core/index.ts`**:
- Export `RoutesData`

### Step 3: Update each facet's `renderDoc()` and `relate()`

All 9 facets: return `DocFact[]` with folder + key + values.

**slots** — `[{ folder: "web", key: "Slots", values }]`

**commands** — `[{ folder: "web", key: "Commands", values }]`

**db-schema** — server-folder facts for DB schema + entity extensions; plugin-level for extendedBy. Use `ctx.root` instead of `REPO_ROOT`.

**exports** — one fact per folder with exports

**contributions** — web-folder for Contributes; plugin-level for Slot contributors. `relate()` stores slotContributors in facet data.

**registrations** — per-runtime folder facts

**cross-refs** — per-folder Uses facts; plugin-level Imported by

**resources** — per-runtime folder facts

**routes** — change T to `RoutesData`. Per-runtime folder for routes; plugin-level for Endpoint callers. `relate()` stores endpointCallers in facet data.

### Step 4: Update compat shim and PluginTree

**`plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`**:
- Add `facets: Facet[]` to `PluginTree`
- Store facets in `buildPluginTree()`; `[]` when `skipBarrelImport`
- Update `populateCompatFields()` for `RoutesData` (`.routes` accessor)
- Copy `slotContributors` from contributions facet data to node compat field

### Step 5: Update docgen

**`plugins/framework/plugins/tooling/plugins/codegen/core/docgen.ts`**:
- Import `getFacet`, `type Facet`, `type DocFact` from `@plugins/plugin-meta/plugins/facets/core`
- Add `renderDocFacts()` aggregation function
- Replace `renderPluginBody()` with generic fact collection + aggregation
- Thread `facets` through render functions via `tree.facets`
- Remove `formatRegistration()` helper
- Keep route-doc functions unchanged

### Step 6: Update re-exports

**`plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`**:
- Re-export `RoutesData` from routes facet core

## Verification

1. `./equin build` — must succeed
2. `./equin check` — all checks pass
3. Spot-check `plugins-details.md` and per-plugin `CLAUDE.md` — new folder-grouped structure
4. `routes.md` unchanged (still uses compat shim)

## Files changed

| File | Change |
|------|--------|
| `plugins/plugin-meta/plugins/facets/core/facets.ts` | Add `DocFact`; simplify `RenderDocContext`; change return type |
| `plugins/plugin-meta/plugins/facets/core/index.ts` | Export `DocFact` |
| `plugins/plugin-meta/plugins/facets/plugins/contributions/core/types.ts` | Add `slotContributors` |
| `plugins/plugin-meta/plugins/facets/plugins/routes/core/types.ts` | Add `RoutesData`; change facet def |
| `plugins/plugin-meta/plugins/facets/plugins/routes/core/index.ts` | Export `RoutesData` |
| `plugins/plugin-meta/plugins/facets/plugins/slots/facet/index.ts` | Return `DocFact[]` |
| `plugins/plugin-meta/plugins/facets/plugins/commands/facet/index.ts` | Return `DocFact[]` |
| `plugins/plugin-meta/plugins/facets/plugins/db-schema/facet/index.ts` | Return `DocFact[]`; use `ctx.root` |
| `plugins/plugin-meta/plugins/facets/plugins/exports/facet/index.ts` | Return `DocFact[]` |
| `plugins/plugin-meta/plugins/facets/plugins/contributions/facet/index.ts` | Return `DocFact[]`; store slotContributors |
| `plugins/plugin-meta/plugins/facets/plugins/registrations/facet/index.ts` | Return `DocFact[]` |
| `plugins/plugin-meta/plugins/facets/plugins/cross-refs/facet/index.ts` | Return `DocFact[]` |
| `plugins/plugin-meta/plugins/facets/plugins/resources/facet/index.ts` | Return `DocFact[]` |
| `plugins/plugin-meta/plugins/facets/plugins/routes/facet/index.ts` | Return `DocFact[]`; update T to RoutesData |
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` | Add `facets` to PluginTree; update compat shim |
| `plugins/framework/plugins/tooling/plugins/codegen/core/docgen.ts` | Replace `renderPluginBody()` with generic aggregation |

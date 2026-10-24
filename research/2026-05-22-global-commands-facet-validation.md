# Commands Facet: Single-Facet Validation

## Context

The [unified facet docgen plan](2026-05-20-global-unified-facet-docgen.md) (Step 2) calls for migrating facets to prove the pattern. This doc scopes to **one facet — `commands`** — as the minimal validation before committing to the rest. Commands is the simplest facet: no `relate()`, no cross-plugin wiring, a single source file (`web/commands.ts`), and a two-line doc render.

The facet infrastructure is already scaffolded (Step 1 is done): `defineFacet`/`getFacet`/`setFacet` in `plugin-tree/core`, `PluginNode.facets: Record<string, unknown>`, `loadFacets()` in `facets/core`, empty `facet.generated.ts`, and the `collectedDir("facet")` codegen token.

## Fix: Facet Primitive Placement

The facet primitives (`Facet`, `FacetDef`, `defineFacet`, `getFacet`, `setFacet`) currently live in `plugin-tree/core/internal/facets.ts`. This is the wrong home — they're about the facet extension mechanism, not the tree. It also creates a structural problem: `facets/core` imports `Facet` type from `plugin-tree/core`, so `plugin-tree/core` can't import `loadFacets` from `facets/core` without creating a cycle.

**Move facet primitives to `facets/core`**. This makes `facets` the single owner of everything facet-related (primitives + loader + discovery), and lets `plugin-tree` depend on `facets` one-way.

### Dependency graph after the move

```
barrel-import  (leaf)
     │
     ▼
facets/core ─────────── owns: Facet, FacetDef, defineFacet, getFacet, setFacet, loadFacets
     │
     ▼
plugin-tree/core ────── owns: PluginNode, CommandDef, parsing helpers, buildPluginTree, enrichPluginTreeDocs
     │                  imports from facets/core: setFacet, loadFacets
     │
     ├─────────────────────────────────────────────┐
     ▼                                             ▼
facets/plugins/commands  ←── imports from      codegen/docgen.ts
  (and future facet         plugin-tree/core:   plugin-view/server
   sub-plugins)             parsing helpers,    plugin-changes/server
                            CommandDef          etc.
```

No cycles. `plugin-tree → facets/core` is one-way. `facets/plugins/* → plugin-tree/core` is a different plugin pair.

### Migration surface (tiny)

Only **one file** outside `plugin-tree` currently imports facet primitives:
- `facets/core/load-facets.ts` — `import type { Facet } from "@plugins/.../plugin-tree/core"` → becomes a local import

All other `plugin-tree/core` consumers import tree/build functions, not facet primitives.

## Approach: Dual-Write

The existing `collectPlugin()` in `plugin-tree.ts` continues to populate `node.commands` exactly as before. The new commands facet independently parses the same file and stores via `setFacet(node, commandsFacetDef, data)`. Doc output stays byte-identical because `docgen.ts` still reads `node.commands`. The facet's `renderDoc()` exists but isn't called by docgen yet (that's Step 5 of the parent plan).

## Implementation

### Step 1: Move facet primitives from `plugin-tree/core` to `facets/core`

**Move** `plugins/plugin-meta/plugins/plugin-tree/core/internal/facets.ts` → `plugins/plugin-meta/plugins/facets/core/facets.ts`

Contents stay identical:
```ts
export interface FacetDef<T> { id: string; _phantom?: T; }
export interface Facet {
  def: FacetDef<unknown>;
  extract: (ctx: unknown) => unknown;
  relate?: (ctx: unknown) => void;
  renderDoc: (data: unknown, ctx: unknown) => string[];
}
export function defineFacet<T>(id: string): FacetDef<T> { return { id }; }
export function getFacet<T>(node: { facets: Record<string, unknown> }, def: FacetDef<T>): T | undefined { ... }
export function setFacet<T>(node: { facets: Record<string, unknown> }, def: FacetDef<T>, data: T): void { ... }
```

**Update `facets/core/index.ts`** — add the new exports:
```ts
export { facetCollectedDir } from "./collected-dir";
export { loadFacets } from "./load-facets";
export { defineFacet, getFacet, setFacet } from "./facets";
export type { Facet, FacetDef } from "./facets";
```

**Update `facets/core/load-facets.ts`** — change import from cross-plugin to local:
```ts
// Before: import type { Facet } from "@plugins/plugin-meta/plugins/plugin-tree/core";
// After:
import type { Facet } from "./facets";
```

**Update `plugin-tree/core/index.ts`** — remove the facet re-exports:
```ts
// Remove these two lines:
// export { defineFacet, getFacet, setFacet } from "./internal/facets";
// export type { Facet, FacetDef } from "./internal/facets";
```

**Delete** `plugins/plugin-meta/plugins/plugin-tree/core/internal/facets.ts` (now empty/moved).

No other files import facet primitives from `plugin-tree/core`, so no other imports need updating.

### Step 2: Export parsing helpers from `plugin-tree/core`

The commands facet needs `parseDefineGroup`, `stripTypes`, `readIfExists`, `matchBracket`. All four are currently private in `plugin-tree.ts`.

**`plugin-tree/core/internal/plugin-tree.ts`**: Add `export` keyword to:
- `readIfExists` (~line 128)
- `stripTypes` (~line 134)
- `matchBracket` (~line 170)
- `parseDefineGroup` (line 186)

**`plugin-tree/core/index.ts`**: Re-export all four as values.

### Step 3: Create commands facet sub-plugin

```
plugins/plugin-meta/plugins/facets/plugins/commands/
  package.json
  facet/index.ts
```

**`package.json`**:
```json
{
  "name": "@singularity/plugin-plugin-meta-facets-commands",
  "version": "0.0.1",
  "private": true
}
```

**`facet/index.ts`**:
```ts
import { join } from "path";
import {
  defineFacet,
  type Facet,
  type CommandDef,
} from "@plugins/plugin-meta/plugins/facets/core";   // ← primitives from facets
import {
  readIfExists,
  stripTypes,
  parseDefineGroup,
} from "@plugins/plugin-meta/plugins/plugin-tree/core"; // ← parsing helpers from plugin-tree

export const commandsFacetDef = defineFacet<CommandDef[]>("commands");

const commandsFacet: Facet = {
  def: commandsFacetDef,

  extract(ctx: unknown): CommandDef[] {
    const { dir } = ctx as { dir: string };
    const src = readIfExists(join(dir, "web", "commands.ts"));
    if (!src) return [];
    return parseDefineGroup(
      stripTypes(src), "defineCommand",
      (memberName, commandId, groupName) => ({ memberName, commandId, groupName }),
    );
  },

  renderDoc(data: unknown, ctx: unknown): string[] {
    const commands = data as CommandDef[];
    if (commands.length === 0) return [];
    const { bodyIndent } = ctx as { bodyIndent: string };
    const subIndent = `${bodyIndent}  `;
    return [
      `${subIndent}- Commands: ${commands.map((c) => `\`${c.groupName}.${c.memberName}\``).join(", ")}`,
    ];
  },
};

export default commandsFacet;
```

Note: `CommandDef` is a type currently exported from `plugin-tree/core`. The commands facet imports it from there. **However**, once facets own their own data types (Step 6 of the parent plan), `CommandDef` would move to the commands facet. For now, keeping it in `plugin-tree` avoids churn since `collectPlugin()` still uses it directly.

Wait — the commands facet imports `Facet` and `defineFacet` from `facets/core`, but also needs `CommandDef`. That type lives in `plugin-tree/core`. So the commands facet imports from both `facets/core` (primitives) and `plugin-tree/core` (types + parsing helpers). That's fine — both are one-way edges.

### Step 4: Wire facet extraction into `enrichPluginTreeDocs()`

Now that `plugin-tree` can import from `facets/core` without creating a cycle, the extraction loop goes in its natural home.

**`plugin-tree/core/internal/plugin-tree.ts`**:

Add imports at top:
```ts
import { loadFacets } from "@plugins/plugin-meta/plugins/facets/core";
import { setFacet } from "./facets";  // wait — facets.ts is gone now
```

Since `facets.ts` moved to `facets/core`, this needs to be:
```ts
import { loadFacets, setFacet } from "@plugins/plugin-meta/plugins/facets/core";
```

At the end of `enrichPluginTreeDocs()`, after Pass 2 (contributions/registrations), add Pass 3:
```ts
  // Pass 3: facet extraction (dual-write alongside monolithic fields)
  const facets = await loadFacets();
  for (const node of tree.byDir.values()) {
    for (const facet of facets) {
      const data = facet.extract({ dir: node.dir });
      setFacet(node, facet.def, data);
    }
  }
  // relate pass (no-op for commands, validates wiring for future facets)
  for (const facet of facets) {
    if (facet.relate) facet.relate({ tree });
  }
```

### Step 5: Build and verify

Run `./equin build`. This will:
1. Regenerate `facet.generated.ts` with the commands entry
2. Run docgen → `buildEnrichedTree()` → `enrichPluginTreeDocs()` → facet extraction runs
3. Produce identical doc output (docgen still reads `node.commands`, not facets)

## Files Changed

| File | Change |
|------|--------|
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/facets.ts` | **Deleted** (moved) |
| `plugins/plugin-meta/plugins/plugin-tree/core/index.ts` | Remove facet re-exports, add parsing helper re-exports |
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` | Export 4 helpers, add facet extraction in `enrichPluginTreeDocs()` |
| `plugins/plugin-meta/plugins/facets/core/facets.ts` | **New** (moved from plugin-tree) |
| `plugins/plugin-meta/plugins/facets/core/index.ts` | Add facet primitive exports |
| `plugins/plugin-meta/plugins/facets/core/load-facets.ts` | Local import instead of cross-plugin |
| `plugins/plugin-meta/plugins/facets/plugins/commands/package.json` | **New** |
| `plugins/plugin-meta/plugins/facets/plugins/commands/facet/index.ts` | **New** |
| `plugins/plugin-meta/plugins/facets/core/facet.generated.ts` | Auto-regenerated by build |

## What This Validates

1. **Correct primitive placement**: `facets/core` owns the entire facet system
2. **Codegen discovery**: `defineCollectedDir("facet")` + `facet/index.ts` → auto-populated `facet.generated.ts`
3. **`loadFacets()`**: Dynamic import, `isFacet()` validation, collection
4. **`extract()` per node**: Filesystem read + regex parse inside a facet, stored via `setFacet()`
5. **`renderDoc()` contract**: Produces output matching the existing hardcoded docgen lines
6. **`relate()` wiring**: The loop calls `relate()` if present (no-op for commands, but proves the hook works)
7. **No regression**: Doc output byte-identical, all checks pass
8. **Clean dependency graph**: No cycles, natural layering

## Verification

```bash
# Before changes — save baseline
./equin build
cp docs/plugins-details.md /tmp/baseline-details.md
cp docs/plugins-compact.md /tmp/baseline-compact.md

# After changes
./equin build
diff /tmp/baseline-details.md docs/plugins-details.md    # must be empty (modulo new plugin entries)
diff /tmp/baseline-compact.md docs/plugins-compact.md    # must be empty (modulo new plugin entries)
./equin check                                       # all pass
```

Note: The new `commands` sub-plugin will appear in the auto-generated plugin docs. The diff won't be fully empty — it will contain the new `commands` plugin entry. All *existing* plugin entries must be byte-identical.

## Open Questions

1. **`CommandDef` ownership**: Currently `CommandDef` is defined and exported from `plugin-tree/core`. Long-term (Step 6 of parent plan), it should move to the commands facet since it's commands-specific data. For now, keeping it in `plugin-tree` avoids churn — `collectPlugin()` still uses it.

2. **Extract context shape**: This plan passes `{ dir: string }`. Future facets (contributions, registrations) will need imported barrel modules from `enrichPluginTreeDocs()` Pass 1. When those facets are added, the extract context will need `{ dir, importedModules }`. Let the type emerge — each facet casts internally. Formalize in Step 4 (unified pipeline).

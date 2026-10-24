# Registrations Facet

## Context

This is the `registrations` facet — part of Step 3 of the unified facet migration
([research/2026-05-20-global-unified-facet-docgen.md](2026-05-20-global-unified-facet-docgen.md)).

Steps 1–2 established the infrastructure and validated the pattern with `commands`. Four facets
(commands, slots, resources, routes) are now live. The `registrations` facet is the first that
**cannot** be extracted by static file analysis — it must read `def.register[]` from runtime barrel
imports. This drives one structural change: extending `ExtractContext` with an optional
`importedModules` field, and updating the Pass 3 call site to populate it.

**Dual-write contract**: `node.runtimeRegistrations` continues to be populated by Pass 2 of
`enrichPluginTreeDocs()`. The facet independently populates `node.facets["registrations"]`. Doc
output stays byte-identical because docgen still reads the monolithic field (Step 5 wires the
facet renderer).

---

## What Gets Extracted

`DocMetaRegistration[]` — one entry per item in `def.register[]` on a plugin's server or central
module. Each entry has:

| Field | Type | Source |
|-------|------|--------|
| `kind` | `string` | `r._kind` (e.g. `"mcp-tool"`, `"job"`, `"trigger-event"`) |
| `factory?` | `string` | `r._factory` (e.g. `"mcpTool"`, `"defineJob"`) |
| `runtime` | `"server" \| "central"` | which barrel the token came from |
| `doc` | `DocMeta` | `r._doc ?? {}` |

Web module is skipped (same as current Pass 2 logic).

---

## Files to Change

### 1. Extend `ExtractContext`

**`plugins/plugin-meta/plugins/facets/core/facets.ts`**

Add `importedModules` as an optional field. Existing facets ignore it — fully backward-compatible.

```ts
export interface ExtractContext {
  dir: string;
  // Barrel-imported modules for this plugin (populated by Pass 1 in enrichPluginTreeDocs).
  // Undefined for facets that only need static file access.
  importedModules?: { mod: Record<string, unknown>; runtime: "web" | "server" | "central" }[];
}
```

### 2. Update Pass 3 Call Site

**`plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`** — Pass 3 loop (~line 1104):

```ts
// Before:
const data = facet.extract({ dir: node.dir });

// After:
const nodeModules = importedModules.get(node.dir) ?? [];
const data = facet.extract({ dir: node.dir, importedModules: nodeModules });
```

`importedModules` (the Map) is already in scope — it is the variable populated by Pass 1 with type
`Map<string, { mod: Record<string, unknown>; runtime: "web" | "server" | "central" }[]>`.

### 3. Export `DocMetaRegistration` from `plugin-tree/core`

Verify `DocMetaRegistration` is exported from
`plugins/plugin-meta/plugins/plugin-tree/core/index.ts`. If not, add it. The facet imports from
`@plugins/plugin-meta/plugins/plugin-tree/core`.

### 4. Create the Facet

**NEW: `plugins/plugin-meta/plugins/facets/plugins/registrations/facet/index.ts`**

```ts
import type { DocMetaRegistration } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import {
  createFacet,
  defineFacet,
  type ExtractContext,
  type RenderDocContext,
} from "@plugins/plugin-meta/plugins/facets/core";

export const registrationsFacetDef = defineFacet<DocMetaRegistration[]>("registrations");

export default createFacet<DocMetaRegistration[]>({
  def: registrationsFacetDef,

  extract(ctx: ExtractContext): DocMetaRegistration[] {
    const { importedModules } = ctx;
    if (!importedModules || importedModules.length === 0) return [];

    const registrations: DocMetaRegistration[] = [];
    for (const { mod, runtime } of importedModules) {
      if (runtime !== "server" && runtime !== "central") continue;
      const def = (mod as { default?: unknown }).default;
      if (!def || typeof def !== "object") continue;
      const rawRegister = (def as Record<string, unknown>).register as
        | Array<{ _kind?: string; _factory?: string; _doc?: { label?: string; detail?: string } }>
        | undefined;
      if (!rawRegister) continue;
      for (const r of rawRegister) {
        if (r._kind) {
          registrations.push({
            kind: r._kind,
            factory: r._factory,
            runtime,
            doc: r._doc ?? {},
          });
        }
      }
    }
    return registrations;
  },

  renderDoc(data: DocMetaRegistration[], ctx: RenderDocContext): string[] {
    if (data.length === 0) return [];
    const indent = `${ctx.bodyIndent}  `;
    const lines: string[] = [];
    for (const runtime of ["server", "central"] as const) {
      const regs = data.filter((r) => r.runtime === runtime);
      if (regs.length === 0) continue;
      lines.push(`${indent}- Register: ${regs.map(formatRegistration).join(", ")}`);
    }
    return lines;
  },
});

function formatRegistration(r: DocMetaRegistration): string {
  const label = r.doc.label;
  if (!r.factory) return `\`${label ?? r.kind}\``;
  return label ? `\`${r.factory}('${label}')\`` : `\`${r.factory}()\``;
}
```

> `renderDoc` mirrors `formatRegistration` from `docgen.ts` exactly. The output per-runtime line
> (`- Register: \`mcpTool('...')\``) is the shape that will be emitted inside the server/central
> section in Step 5. For now docgen ignores this output (dual-write; it still reads
> `node.runtimeRegistrations`).

### 5. Create `package.json`

**NEW: `plugins/plugin-meta/plugins/facets/plugins/registrations/package.json`**

Mirror the commands facet `package.json` exactly (same workspace deps).

### 6. Create `CLAUDE.md`

**NEW: `plugins/plugin-meta/plugins/facets/plugins/registrations/CLAUDE.md`**

Minimal stub — the autogen block will be populated by `./equin build`.

---

## Auto-Generated File

After `./equin build`, the codegen scanner discovers the new `facet/index.ts` and appends
the registrations entry to:

**`plugins/plugin-meta/plugins/facets/core/facet.generated.ts`**

No manual edits needed.

---

## Verification

1. `./equin build` succeeds — `facet.generated.ts` gets the new `registrations` entry.
2. `diff docs/plugins-compact.md` — empty (doc output unchanged; docgen still reads
   `node.runtimeRegistrations`).
3. `diff docs/plugins-details.md` — empty (same reason).
4. Spot-check: open the jobs plugin CLAUDE.md — autogen block still shows
   `Register: \`defineJob(...)\`` as before.
5. `./equin check` passes all checks.
6. Manually verify: in a Node/Bun REPL or via a debug endpoint, check that
   `getFacet(jobsPluginNode, registrationsFacetDef)` returns the expected `DocMetaRegistration[]`
   for the jobs plugin.

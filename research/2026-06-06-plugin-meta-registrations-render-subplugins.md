# Registrations facet — render sub-plugins (Facets v3, Phase 3)

## Context

A **facet** is a self-contained slice of plugin metadata. Each facet feeds four
surfaces: **doc** (markdown), **detail** (Forge plugin pane), **diff** (PR review),
and **catalog** (Forge aggregated tables). Per the v3 design
(`research/2026-06-02-global-facets-rendering-separation-v3.md`, Phase 3), build-time
rendering (`renderDoc`) lives in the facet's `facet/`, the pure `toComparable` projection
lives in `core/`, and the three browser renderers live in `plugins/render-{diff,detail,catalog}/web/`
sub-plugins discovered via web slots.

The `registrations` facet (`plugins/plugin-meta/plugins/facets/plugins/registrations/`)
currently has only `core/` (type + facetDef) and `facet/` (extract + renderDoc). It has
**no render sub-plugins**, so it is invisible in the detail pane, the catalog, and the PR
diff. Every other facet (exports, commands, slots, routes, resources, contributions,
cross-refs, db-schema) already has all three. This brings `registrations` to parity.

The just-committed `commands` facet (`dc4163bbe`) is the reference precedent — we mirror it
byte-for-byte, deviating only where the registrations data shape differs.

### Data shape (what we render)

`node.facets["registrations"]` is `DocMetaRegistration[]`:

```ts
interface DocMetaRegistration {
  kind: string;                      // "mcp-tool", "job", "trigger-event", …
  factory?: string;                  // "Mcp.tool", "defineJob", … (optional)
  runtime: "server" | "central";
  doc: DocMeta;                      // { label?: string; detail?: string }
}
```

The existing `facet/index.ts` already has a `formatRegistration(r)` helper producing the
canonical string: ``factory('label')`` / ``factory()`` / ``label ?? kind``. The three
renderers reuse that exact formatting logic.

### Runtime-only / partial-data caveat

`registrations.extract()` reads `ctx.importedModules`, populated only when `buildPluginTree`
runs **without** `skipBarrelImport`. `compute-plugin-diff.ts` always passes
`skipBarrelImport: true`, so in the **diff** context registrations is always `[]` on both
sides — the diff renderer will exist and be correct but render no added/removed rows today
(acceptable; the slot must still be filled for completeness/parity). Detail and catalog are
served from the full tree, but until Phase 4 flips the `skipBarrelImport` gate in
`buildPluginTree`, `node.facets["registrations"]` may also be empty there. **Every renderer
must guard `data.length === 0`** (detail returns `null`; catalog `rows()` skips empty
entries; diff returns `[]`).

## Approach

Mirror the `commands` facet exactly. Five files (1 new core file + 1 edit, plus 3 sub-plugin
trees). Component files go in `web/components/` per the components-folder rule; barrels contain
only imports + a single `export default satisfies PluginDefinition`.

### 1. `core/to-comparable.ts` (NEW) + `core/index.ts` (EDIT)

New `registrationsToComparable` — pure projection mirroring `formatRegistration`, prefixed by
runtime so diffs distinguish server vs central:

```ts
import type { DocMetaRegistration } from "./types";

/** Diff projection: one `runtime: factory('label')` string per registration.
 *  Mirrors formatRegistration (facet/index.ts) so diff matches doc rendering.
 *  No legacy registrationStrings() existed — this defines the diff. */
export function registrationsToComparable(data: DocMetaRegistration[]): string[] {
  return data.map((r) => {
    const body = !r.factory
      ? (r.doc.label ?? r.kind)
      : r.doc.label
        ? `${r.factory}('${r.doc.label}')`
        : `${r.factory}()`;
    return `${r.runtime}: ${body}`;
  });
}
```

Add to `core/index.ts`:
```ts
export { registrationsToComparable } from "./to-comparable";
```

> Keeps `core/` browser-safe (index + types + to-comparable only; no fs) per
> [[reference_facet_core_browser_safe_no_parse]].

### 2. `plugins/render-diff/web/index.ts` (NEW)

Mirror `commands/.../render-diff/web/index.ts`:
```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { PluginChangesSlots } from "@plugins/review/plugins/plugin-changes/web";
import {
  registrationsToComparable,
  type DocMetaRegistration,
} from "@plugins/plugin-meta/plugins/facets/plugins/registrations/core";

export default {
  name: "Registrations: Diff Renderer",
  description: "Diff renderer for the registrations facet (PR review).",
  contributions: [
    PluginChangesSlots.DiffRenderer({
      facetId: "registrations",
      label: "Registrations",
      toComparable: (data) => registrationsToComparable(data as DocMetaRegistration[]),
    }),
  ],
} satisfies PluginDefinition;
```

### 3. `plugins/render-detail/web/` (NEW)

`index.ts` mirrors commands; component reads `node.facets["registrations"]`. Registrations
carry a runtime dimension absent from commands, so the row shows a runtime tag plus the
formatted registration string and optional `doc.detail`. Flat list (matching the commands
precedent's simplicity), runtime indicated per row.

`index.ts`:
```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { PluginViewSlots } from "@plugins/plugin-meta/plugins/plugin-view/web";
import { RegistrationsDetailSection } from "./components/registrations-detail-section";

export default {
  name: "Registrations: Detail Section",
  description: "Per-plugin registrations section in the plugin detail pane.",
  contributions: [
    PluginViewSlots.Section({
      id: "registrations",
      label: "Registrations",
      component: RegistrationsDetailSection,
    }),
  ],
} satisfies PluginDefinition;
```

`components/registrations-detail-section.tsx`:
```tsx
import {
  Section,
  RUNTIME_COLORS,
  type PluginNode,
} from "@plugins/plugin-meta/plugins/plugin-view/web";
import type { DocMetaRegistration } from "@plugins/plugin-meta/plugins/facets/plugins/registrations/core";

// Reads node.facets[id] directly rather than importing the build-time facets/core
// barrel (would drag loadFacets + fs into the browser bundle). The type-only import
// from the facet core is erased and safe.
const REGISTRATIONS_FACET_ID = "registrations";

function format(r: DocMetaRegistration): string {
  if (!r.factory) return r.doc.label ?? r.kind;
  return r.doc.label ? `${r.factory}('${r.doc.label}')` : `${r.factory}()`;
}

export function RegistrationsDetailSection({ node }: { node: PluginNode }) {
  const data = node.facets?.[REGISTRATIONS_FACET_ID] as
    | DocMetaRegistration[]
    | undefined;
  if (!data || data.length === 0) return null;

  return (
    <Section title="Registrations" count={String(data.length)}>
      <div className="flex flex-col gap-0.5">
        {data.map((r, i) => (
          <div
            key={`${r.runtime}:${r.kind}:${i}`}
            className="flex items-center gap-2 px-2 py-0.5 text-xs"
          >
            <code className="min-w-0 truncate font-mono text-foreground">
              {format(r)}
            </code>
            <span className={`ml-auto shrink-0 font-mono text-3xs ${RUNTIME_COLORS[r.runtime]}`}>
              {r.runtime}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}
```
> `RUNTIME_COLORS` covers `"server" | "central"` (verified). If its typing causes
> friction at build, fall back to a muted `text-muted-foreground/50` tag (mirroring the
> commands commandId style) — runtime color is a nicety, not load-bearing.

### 4. `plugins/render-catalog/web/` (NEW)

`index.ts`:
```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Catalog } from "@plugins/apps/plugins/forge/plugins/catalog/web";
import { registrationsFacetTable } from "./registrations-facet-table";

export default {
  name: "Registrations: Catalog Table",
  description: "Aggregated cross-plugin registrations table in the Forge catalog.",
  contributions: [Catalog.FacetTable(registrationsFacetTable)],
} satisfies PluginDefinition;
```

`registrations-facet-table.tsx` (mirror `commands-facet-table.tsx`; columns:
Registration, Kind, Runtime, Plugin):
```tsx
import {
  defineFacetTable,
  type FacetTableEntry,
  PluginChip,
} from "@plugins/apps/plugins/forge/plugins/catalog/web";
import type { ColumnDef } from "@plugins/primitives/plugins/data-table/web";
import type { PluginNode } from "@plugins/plugin-meta/plugins/plugin-view/core";
import type { DocMetaRegistration } from "@plugins/plugin-meta/plugins/facets/plugins/registrations/core";
import { MdAppRegistration } from "react-icons/md";

type RegistrationRow = {
  plugin: PluginNode;
  name: string;
  kind: string;
  runtime: string;
};

function format(r: DocMetaRegistration): string {
  if (!r.factory) return r.doc.label ?? r.kind;
  return r.doc.label ? `${r.factory}('${r.doc.label}')` : `${r.factory}()`;
}

const columns: ColumnDef<RegistrationRow>[] = [
  {
    id: "name",
    header: "Registration",
    width: "flex-1 min-w-0",
    value: (row) => row.name,
    cell: (row) => (
      <code className="truncate font-mono text-foreground">{row.name}</code>
    ),
  },
  {
    id: "kind",
    header: "Kind",
    value: (row) => row.kind,
    cell: (row) => (
      <span className="font-mono text-muted-foreground">{row.kind}</span>
    ),
  },
  {
    id: "runtime",
    header: "Runtime",
    value: (row) => row.runtime,
    cell: (row) => (
      <span className="font-mono text-muted-foreground">{row.runtime}</span>
    ),
  },
  {
    id: "plugin",
    header: "Plugin",
    value: (row) => row.plugin.hierarchyId,
    cell: (row) => <PluginChip hierarchyId={row.plugin.hierarchyId} />,
  },
];

function rows(entries: FacetTableEntry[]): RegistrationRow[] {
  const result: RegistrationRow[] = [];
  for (const entry of entries) {
    const data = entry.data as DocMetaRegistration[];
    for (const r of data) {
      result.push({
        plugin: entry.node,
        name: format(r),
        kind: r.kind,
        runtime: r.runtime,
      });
    }
  }
  return result;
}

export const registrationsFacetTable = defineFacetTable<RegistrationRow>({
  facetId: "registrations",
  label: "Registrations",
  icon: MdAppRegistration,
  columns,
  rows,
  rowKey: (r) => `${r.plugin.hierarchyId}:${r.runtime}:${r.name}`,
});
```
> Confirm `MdAppRegistration` exists in `react-icons/md` during build; if not, use a
> present alternative (e.g. `MdExtension`).

### 5. CLAUDE.md prose (NEW, one per sub-plugin)

Per [[reference_claudemd_autogen_block]], write **prose only** — `./equin build`
codegen inserts the `## Plugin reference` block. One short `CLAUDE.md` in each of the three
`render-*/` folders, mirroring the wording of the commands equivalents.

## Files

| File | Action |
|---|---|
| `…/registrations/core/to-comparable.ts` | NEW — `registrationsToComparable` |
| `…/registrations/core/index.ts` | EDIT — export `registrationsToComparable` |
| `…/registrations/plugins/render-diff/web/index.ts` | NEW |
| `…/registrations/plugins/render-diff/CLAUDE.md` | NEW (prose) |
| `…/registrations/plugins/render-detail/web/index.ts` | NEW |
| `…/registrations/plugins/render-detail/web/components/registrations-detail-section.tsx` | NEW |
| `…/registrations/plugins/render-detail/CLAUDE.md` | NEW (prose) |
| `…/registrations/plugins/render-catalog/web/index.ts` | NEW |
| `…/registrations/plugins/render-catalog/web/registrations-facet-table.tsx` | NEW |
| `…/registrations/plugins/render-catalog/CLAUDE.md` | NEW (prose) |

(`…` = `plugins/plugin-meta/plugins/facets/plugins`)

No consumer edits: hosts (`plugin-changes`, `plugin-view`, `forge/catalog`) iterate
contributions generically and pick the new ones up automatically. No registry/codegen edits —
sub-plugins are discovered by their barrels.

## Verification

1. `./equin build` — succeeds; codegen fills the three `CLAUDE.md` reference blocks and
   the `facets/CLAUDE.md` autogen sub-plugin list now shows `registrations` with its three
   render children (mirroring the other 8 facets).
2. `./equin check` — passes (boundaries, eslint, plugins-doc-in-sync). Watch for: no
   authored plugin `id:`, no arbitrary Tailwind sizes (`text-3xs` only), barrel purity.
3. Forge catalog (`http://<worktree>.localhost:9000`, Forge → Catalog): a **Registrations**
   tab appears. (Rows may be empty until the Phase-4 `skipBarrelImport` flip — that's the
   documented partial-data caveat, not a bug.)
4. Forge plugin detail pane for a plugin that registers MCP tools/jobs (e.g.
   `infra/plugins/mcp` or `infra/plugins/jobs`): a **Registrations** section renders when
   data is present; absent (returns `null`) when empty.
5. PR review diff: a **Registrations** diff group is wired (no rows in the diff path by
   design — `skipBarrelImport`).
6. Empty-case sanity: a plugin with no registrations shows no detail section and contributes
   no catalog rows — no crash.

## Out of scope

- The Phase-4 `buildPluginTree` `skipBarrelImport` gate flip (separate task) — until it lands,
  detail/catalog data for this runtime-only facet may be empty. Renderers handle that
  gracefully now.
- Any consumer-side changes; the generic collection APIs already iterate contributions.

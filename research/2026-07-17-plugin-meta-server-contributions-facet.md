# Capture server `defineServerContribution` contributions in the contributions facet

## Context

`defineServerContribution` (`plugins/framework/plugins/server-core/core/contributions.ts`)
marks each server contribution with a `_kind` **symbol** (whose `.description`
equals the registry token, e.g. `"page.block-data"`) and a `_doc`, but **no
`_slotId`**. The contributions-facet runtime extractor
(`plugins/plugin-meta/plugins/facets/plugins/contributions/facet/index.ts:100`)
drops every contribution that lacks `_slotId`:

```ts
for (const c of rawContributions) {
  if (!c._slotId) continue;   // ← server contributions die here
```

Consequently server contributions are **invisible to the whole introspection
system**: they never render in `docs/plugins-details.md` / per-plugin
`CLAUDE.md`, and no facet-based check can read them off the plugin tree. This
forced a workaround in `plugins/page/plugins/editor/check/index.ts`
(`page.editor:block-data-registered`): `collectServerBlockDataTypes()`
reflectively barrel-imports every server module by hand to read its
`Editor.BlockData` contributions, because `getFacet(node, contributionsFacetDef).runtime`
is permanently empty for them.

The barrel-import loop that populates `ExtractContext.importedModules`
(`plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts:352-365`)
**already imports all three runtime barrels** (web/server/central), so the
server contributions are already in `ctx.importedModules` — the facet simply
discards them at the `_slotId` gate. The fix is to branch on the marker instead
of dropping.

**Intended outcome:** server contributions become first-class — they render in
docs and are readable by facet-based checks exactly like web slot contributions,
and the editor check reads `Editor.BlockData` off the facet instead of
reflectively importing barrels.

**Decision (confirmed with user):** *Render all + add labels.* Capture every
server contribution generically (no per-token special-casing — required by
collection-consumer separation), and add a `docLabel` to each currently-unlabeled
token so every server contribution renders with a meaningful label. Resources
declared via `Resource.Declare(...)` will therefore appear both under the
existing `Resources:` doc line and under a new server `Contributes:` line — an
accepted redundancy (different lens).

## Before / after (real example)

`page/text` server barrel: `contributions: [Editor.BlockData(textBlock)]`
(`docLabel: (h) => h.type` → `"text"`).

Before — the server contribution is invisible:
```
  - Server:
    - Uses: `page/editor.Editor`
```
After:
```
  - Server:
    - Contributes: `page.block-data` "text"
    - Uses: `page/editor.Editor`
```
Format is `` `<registry-token>` "<label>" `` — identical to the existing Web
`Contributes:` line minus the `→ Component` suffix (server has no React
component).

## Changes

### 1. `contributions/core/types.ts` — discriminant on `DocMetaContribution`

Add a required `kind` discriminant:

```ts
export interface DocMetaContribution {
  /** "slot" = web slot contribution (`_slotId`); "server" = server registration (`_kind`). */
  kind: "slot" | "server";
  slotId: string;
  slotDisplayName?: string;
  componentName?: string;
  doc: DocMeta;
  id?: string;
  pluginId?: string;
}
```

For a server contribution `slotId` holds `_kind.description` (the registry
token). `componentName`/`slotDisplayName` stay undefined (no component, no
`SlotDef`); `renderDoc` already falls back to `slotId`.

### 2. `contributions/facet/index.ts` — `extract()` runtime loop

Replace the single `if (!c._slotId) continue;` skip with a marker branch. Widen
the `rawContributions` element type to include `_kind?: symbol`. Read the source
runtime from `importedModules` (currently destructured as `{ mod }` only —
change to `{ mod }`; the marker, not the barrel, is the discriminant):

```ts
for (const c of rawContributions) {
  if (typeof c._slotId === "string") {
    // web slot contribution (existing behavior)
    const comp = c.component;
    const componentName =
      typeof comp === "function" && comp.name ? (comp.name as string) : undefined;
    runtimeContributions.push({
      kind: "slot",
      slotId: c._slotId,
      componentName,
      doc: c._doc ?? {},
      id: typeof c.id === "string" ? c.id : undefined,
    });
  } else if (typeof c._kind === "symbol" && c._kind.description) {
    // server registration (defineServerContribution)
    runtimeContributions.push({
      kind: "server",
      slotId: c._kind.description,
      doc: c._doc ?? {},
      id: typeof c.id === "string" ? c.id : undefined,
    });
  }
  // else: no recognizable marker → skip (unchanged for malformed entries)
}
```

### 3. `contributions/facet/index.ts` — `relate()`

The slots-facet joins apply only to web slot contributions; guard them so a
server `slotId` (e.g. `"page.block-data"`) can never accidentally collide with a
web `SlotDef.slotId`:

- Display-name fill: `if (c.kind === "slot" && !c.slotDisplayName) c.slotDisplayName = slotDisplayNames.get(c.slotId);`
  Keep `c.pluginId = node.id` **outside** the guard (applies to all runtime
  contributions, server included).
- Per-slot reverse index loop over `data.runtime`: add `if (c.kind !== "slot") continue;`
  before `slotById.get(c.slotId)`.

(The static-contribution passes are unchanged; server contributions never enter
`data.static`, which is web-source-parsed only.)

### 4. `contributions/facet/index.ts` — `renderDoc()`

Split the single `runtime` fact into web + server folders, reusing the existing
formatter:

```ts
renderDoc(data) {
  const facts: DocFact[] = [];
  const fmt = (c: DocMetaContribution) => {
    const parts = [`\`${c.slotDisplayName ?? c.slotId}\``];
    if (c.doc.label) parts.push(`"${c.doc.label}"`);
    if (c.doc.detail) parts.push(`(${c.doc.detail})`);
    if (c.componentName) parts.push(`→ \`${c.componentName}\``);
    return parts.join(" ");
  };
  const web = data.runtime.filter((c) => c.kind === "slot");
  const server = data.runtime.filter((c) => c.kind === "server");
  if (web.length) facts.push({ folder: "web", key: "Contributes", values: web.map(fmt) });
  if (server.length) facts.push({ folder: "server", key: "Contributes", values: server.map(fmt) });
  return facts;
}
```

The `resources` facet already uses `folder: "server"`, so the server
`Contributes:` line renders under the Server section next to `Resources:`,
`Register:`, etc. (Minor pre-existing imprecision, left as-is: a `central`-barrel
contribution renders under its marker-derived folder, not `central`; no central
barrel carries contributions today.)

### 5. `plugins/page/plugins/editor/check/index.ts` — drop the barrel-import workaround

The whole reason this change exists. Delete `collectServerBlockDataTypes()` and
read server `BlockData` off the same faceted tree the web half already uses.
Merge both reads into the single `for (const node of tree.byDir.values())` loop:

```ts
for (const c of facet.runtime) {
  if (c.kind === "slot" && c.slotId === WEB_BLOCK_SLOT) {
    const type = c.doc.label;
    if (type) { /* existing webTypeToPlugins push */ }
  } else if (c.kind === "server" && c.slotId === SERVER_BLOCK_DATA_SLOT) {
    const type = c.doc.label;
    if (type) serverTypes.add(type);
  }
}
```

Remove now-dead imports/locals: `existsSync`, `join`, `registerBarrelStubs`,
`importBarrel`, `serverDirs`, and the `node.runtimes.server` branch. Keep the
two loud-fail guards (empty web set; missing `page` canary) and the missing-type
reporting — `serverTypes` now comes from the facet. Update the stale
`collectServerBlockDataTypes` doc comment (lines 31-45) that explains the
workaround; it no longer applies.

### 6. Add `docLabel` to currently-unlabeled server tokens

Per the "add labels" decision, give each unlabeled `defineServerContribution`
whose payload has a natural identifier a `docLabel`. Exact field per token
(verified against payload types):

| Token (file) | debugName | add `docLabel` |
|---|---|---|
| `resources.ts` `declareToken` | `resource.declare` | `(r) => r.key` |
| `events/.../trigger-contributions.ts` `Trigger` | `trigger` | `(t) => t.do.name` |
| `derived-tables/.../contribution.ts` `DerivedTable` | `derived-table` | `(s) => s.table` |
| `derived-views/.../contribution.ts` `View` | `derived-view` | `(c) => getViewConfig(c.view).name` (import `getViewConfig` from `drizzle-orm/pg-core`, as `rebuild.ts` does) |
| `config_v2/.../contribution.ts` `ConfigV2.Register` | `ConfigV2.Register` | `(c) => c.descriptor.name` |
| `change-feed/.../exclusion.ts` `ExcludeFromChangeFeed` | `change-feed-exclusion` | `(c) => getTableName(c.table)` (already imported) |
| `release/.../env-provider.ts` `Release.EnvProvider` | `Release.EnvProvider` | `(p) => p.target` |
| `container-tasks/.../contribution.ts` `ContainerTask` | `container-tasks` | `(c) => c.id` |

**Already labeled — do not touch:** `Editor.BlockData` (`h.type`), `ReportKind`
(`k.kind`), `BackupTarget`/`BackupSource` (`p.name`), `PageLinks.Extractor`
(`type ?? "* (all blocks)"`), `TraceEventClass` (`s.id`), `ReportNoiseRule`
(`r.id`), fields `filter-sql`/`value-text-cast`/`storage` (`p.type.id`).

**No natural per-instance label (payload is a bare callback) — leave unlabeled,
render as the bare token:** `BlockLifecycle.BeforeDelete`
(`page.editor.block.beforeDelete`), `DataViewServer.QueryAugmentor`
(`data-view.query-augmentor`), `AttachmentBlock.Collector`
(`page.attachment-block.collector`). These have 1–few contributors and the token
name is self-describing, so a bare `` `token` `` line is fine.

### 7. Docs regeneration

`./equin build` regenerates `docs/plugins-details.md`, the slim
`docs/plugins-compact.md`, and every affected per-plugin `CLAUDE.md` autogen
block; the `plugins-doc-in-sync` check fails until they are committed. This
surfaces server `Contributes:` lines across many plugins (every plugin with a
`contributions: []` server barrel) — the intended outcome.

## Consumers verified unaffected

- `plugin-meta/closure/core/classify-edges.ts` reads only `data.static` (soft
  edges from web-source parse) — server contributions are never in `static`, and
  the server-barrel import edge is already a hard edge via `cross-refs`. No change.
- `render-detail` / `render-contributions` / `contributionsToComparable` read
  only `data.static`. Adding `kind` + server entries to `runtime` does not touch
  them. (Surfacing server contributions in the Studio UI is **out of scope** —
  those surfaces don't render web `runtime` contributions either; docs + checks
  are the target, per the task.)
- Only `extract()` constructs `DocMetaContribution`, so the new required `kind`
  field type-checks everywhere.

## Verification

1. `./equin build` — regenerates docs + migrations, restarts server.
   Confirms the barrel-import facet path still runs and docs regenerate clean.
2. Run the de-workaround-ed check:
   `./equin check page.editor:block-data-registered` → passes, now sourcing
   server `BlockData` from the facet (canary `page` present ⇒ facet scan healthy).
3. Inspect regenerated docs:
   - `rg -n 'page.block-data' docs/plugins-details.md` → `page/text` (and every
     block type) shows `Contributes: \`page.block-data\` "<type>"` under **Server**.
   - `rg -n 'resource.declare|derived-view|derived-table' docs/plugins-details.md`
     → labeled server contribution lines (e.g. `` `resource.declare` "tasks" ``,
     `` `derived-view` "attempts_v" ``) appear under Server for `tasks-core` etc.
4. `./equin check plugins-doc-in-sync plugins-registry-in-sync type-check`
   → all green (docs committed, types sound).
5. Quick facet-shape sanity (optional): a `bun:test` under
   `contributions/facet/` that builds a tiny faceted tree over the editor
   subtree and asserts `data.runtime` contains a `{ kind: "server", slotId:
   "page.block-data" }` entry — mirrors how the check now reads it.

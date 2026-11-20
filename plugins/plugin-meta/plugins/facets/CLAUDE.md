# facets

A **facet** is a self-contained slice of plugin metadata (exports, slots,
commands, routes, resources, db-schema, cross-refs, contributions,
registrations). Each facet runs against every plugin and produces structured
data consumed by four surfaces: **doc** (markdown), **detail** (Studio plugin
pane), **diff** (PR review), and **contributions** (Studio aggregated tables).

## Mental model: separate by *runtime*, not by "rendering"

A facet is split across folders by **the runtime that executes the code** —
identical to the web/server/core split used everywhere else in the repo:

- `core/` — types, the `facetDef`, and **pure data transforms** (`toComparable`).
  Runtime-agnostic; importable from either build-time or the browser.
- `facet/` — **build-time** operations (`extract`, `relate`, `renderDoc`),
  discovered by `loadFacets()` (dynamic import; runs inside `./equin build`,
  browser-less), which lives in its own sub-plugin, `plugins/loader/core`,
  together with the `facet` collected dir and its `facet.generated` registry.
  It is build tooling: `facets/core` holds only the data accessors
  (`getFacet`, `setFacet`, the types), so code that READS facet data — the
  closure engine, a serving backend — never reaches the extractors
  (`boot:closure-digestable`). `loadFacets()` is a thin wrapper over the shared
  `loadCollectedDir` helper (`@plugins/framework/plugins/tooling/plugins/collected-dir/core`),
  the same uniform discovery substrate every collected runtime uses (`facet`,
  `check`, `web`, `server`, …) — each marked by `defineCollectedDir("<runtime>")`.
- `plugins/render-{diff,detail,contributions}/web/` — **browser** React renderers,
  discovered by web slots.

`renderDoc` lives on the facet (not in a render sub-plugin) because doc rendering
is a build-time string operation, co-located with the facet's other build-time
ops. Diff/detail/contributions are browser React. Same data, different runtimes,
different homes — this is coherence, not asymmetry.

## Generic collection API

The facets plugin exposes a **generic API** (`loadFacets` from `loader/core`,
`getFacet`, `DocFact`). The four rendering/doc consumers (docgen, Studio detail, Studio
contributions, PR diff) use only this generic API — they iterate over collected
facets/renderers and call `renderDoc()` / `getFacet()` / the render slot, never
importing or naming an individual facet sub-plugin. A consumer may read
`node.facets[id]` only via an `id` carried by a *contribution* (e.g.
`renderer.facetId`), never a hardcoded literal.

**Rule: rendering/doc consumers must never name a facet.** If one needs to, the
abstraction is leaking — redesign the generic API. (A non-rendering runtime
concern that genuinely depends on one specific aspect may import that facet's
`core/` directly; it is not one of the four generic surfaces, so naming it is
honest rather than a leak.)

## Facet vs. core PluginNode

The internal `PluginNode` (`plugin-tree/core`) carries only **structural
identity**: `path`, `name`, `hierarchyId`, `description`, `runtimes`,
`collapsed`, `loadBearing`, `children`, and the generic `facets` bag. Everything
describing *what a plugin contributes* is a facet, surfaced via
`node.facets[id]`. **New metadata that isn't structural identity becomes a new
facet, never a new flat field on `PluginNode`.** A facet's `relate()` writes its
cross-plugin reverse indexes into its own facet data (via `getFacet`), never
onto `PluginNode`.

## Adding a facet

Adding a facet = adding one folder subtree; no consumer changes.

1. `core/` — declare the data type and `export const fooFacetDef =
   defineFacet<FooData>("foo")`. Add a pure `fooToComparable(data): string[]` if
   the facet appears in the diff surface.
2. `facet/index.ts` — `export default createFacet({ def, extract, relate?,
   renderDoc })`. Import parsing helpers (`parseDefineGroup`, `maskSource`, …)
   from `@plugins/plugin-meta/plugins/parse-utils/core` and the file walkers
   (`walkFilesSync`, `readIfExistsSync`, `pathExistsSync`) from
   `@plugins/plugin-meta/plugins/parse-utils/plugins/source-files/core`; import the facet's own types
   from its `core/`. Enumerate source files with `walkFilesSync` / `walkFilesAsync`,
   never a private `readdir` walk: they own the rule that test code (`*.test.ts`,
   `__tests__/`, `<runtime>/testing/`) and sub-plugin trees are not the plugin's
   surface. Docgen enforces it on the output: a rendered fact naming a test-code
   path fails the build (`codegen/core/doc-facts-guard.ts`).
3. `plugins/render-diff/web/` — contribute a `DiffRenderer { facetId, label,
   toComparable }` to `review.plugin-changes.diff-renderer`.
4. `plugins/render-detail/web/` — contribute a `PluginView.Section` whose Section
   `id` **must equal the facet id**; read `node.facets[id]`.
5. `plugins/render-contributions/web/` — contribute a `Contributions.FacetTable {
   facetId, label, columns, rows }` to `contributions.facet-table`.

Run `./equin build`; the `facets:render-complete` check (`facets/check/`)
fails the build unless every facet covers all three render slots with a matching
facet id.

See `plugins/commands/` for the reference implementation.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Facet-based plugin metadata extraction and docgen pipeline
- Cross-plugin:
  - Imported by:
    - `apps/deploy/deploy-secrets/approvals`
    - `framework/tooling/codegen`
    - `plugin-meta/closure`
    - `plugin-meta/facets/contributions`
    - `plugin-meta/facets/cross-refs`
    - `plugin-meta/facets/db-schema`
    - `plugin-meta/facets/deploy-secrets`
    - `plugin-meta/facets/exemptions`
    - `plugin-meta/facets/exports`
    - `plugin-meta/facets/registrations`
    - `plugin-meta/facets/resources`
    - `plugin-meta/facets/routes`
    - `plugin-meta/facets/slots`
    - `plugin-meta/facets/structure`
    - `plugin-meta/plugin-tree/faceted`
- Core:
  - Exports (types):
    - `DocFact`
    - `DocFactGroup`
    - `EnrichContext`
    - `ExtractBatch`
    - `ExtractContext`
    - `Facet`
    - `FacetDef`
    - `RenderDocContext`
  - Exports (values):
    - `createFacet`
    - `defineFacet`
    - `docFactValues`
    - `getFacet`
    - `setFacet`
- Sub-plugins:
  - **`contributions`** [3 sub-plugins]
  - **`cross-refs`** [3 sub-plugins]
  - **`db-schema`** [3 sub-plugins]
  - **`deploy-secrets`** [3 sub-plugins]
  - **`exemptions`** [3 sub-plugins]
  - **`exports`** [3 sub-plugins]
  - **`loader`** — Loads the facet extractors: the facet collected dir (facet.generated, one entry per facets/plugins/<f>/facet barrel) and loadFacets / loadFacetSources. Build tooling only — kept out of facets/core…
  - **`registrations`** [3 sub-plugins]
  - **`resources`** [3 sub-plugins]
  - **`routes`** [exempt] [3 sub-plugins]
  - **`slots`** [3 sub-plugins]
  - **`structure`** [3 sub-plugins]

<!-- AUTOGENERATED:END -->

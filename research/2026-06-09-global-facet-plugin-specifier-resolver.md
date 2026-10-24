# Shared `@plugins/…` → plugin-node resolver + runtime-folder single-sourcing

Date: 2026-06-09 · Category: global (plugin-meta/facets + framework/plugin-id + framework/tooling/boundaries)

## Context

The facet docgen pipeline resolves `@plugins/…` module specifiers to plugin nodes
using naive regexes that only match **top-level** plugins (a single path segment
before the runtime suffix). Any plugin nested under an umbrella —
`@plugins/page/plugins/editor/server` — never matches, so it is **silently
dropped** from generated cross-reference docs. The build stays green, so the
omission is invisible.

Observed symptom: `apps/story/marker`'s `defineExtension(_blocks, "story", …)` on
`@plugins/page/plugins/editor/server` produces no "Entity extension of …" line in
its autogen `CLAUDE.md`, and no reciprocal "Extended by" line on `page/editor`.
The DB table (`page_blocks_ext_story`) is correct — only the doc cross-reference
is missing.

This is a **class of bug** with two compounding layers, present at **three** sites:

1. **Regex too narrow.** `db-schema/facet/index.ts:123`
   (`/@plugins\/([^/"'`]+)\/(?:server|central|shared|core)/`) and
   `cross-refs/facet/index.ts:21` (`@plugins\/([^/"'`]+)\/${runtime}…`) capture one
   segment, so nested specifiers never match.
2. **Lookup keyed by bare leaf name.** All three facets build
   `byName = Map<node.name, node>` and look up by the bare basename, which
   collides across same-named nested plugins (many `shell`, `render-detail`, …).
   The third site is `exports/facet/index.ts:58-72`, which consumes cross-refs'
   `apiUses` strings via `use.indexOf(".")` + `byName.get()` — same two layers.

There is no shared, correct resolver; each facet re-derives one ad hoc. Two
*correct* longest-prefix resolvers already exist as precedent
(`boundaries/core/resolve.ts:84` and `plugin-boundaries/check/index.ts:935`), both
keyed on `node.path` — but neither is reusable by the facets.

Separately, the runtime-folder vocabulary (`web/server/central/core/shared`) is
**hardcoded ~9 times** across these facets (cross-refs ×5, exports ×4, db-schema
regex), and has already **drifted**: `exports/core/to-comparable.ts:8` drops
`shared`; the db-schema regex drops `web`; even `boundaries/core/types.ts:21`'s
`RuntimeName` type drops `core`. The canonical source is
`runtimeNames` (`boundaries/core`, derived from `boundary-config.runtimes` keys),
but it lives in a build-time barrel that transitively imports Node `fs`/`path`
(`createBoundaryCheck`), so it **cannot** be imported into the `core/`+`web/`
layers without dragging the boundary checker into the browser bundle.

### Intended outcome

1. One tested resolver, used everywhere a `@plugins/…` specifier maps to a plugin,
   that handles arbitrary nesting and resolves to a **unique** node.
2. Make silent drops **impossible**: an unresolvable `@plugins/…` ref fails the
   build loudly.
3. Eliminate the runtime-folder hardcodes via a single browser-safe source.

## Design decisions (settled with the user)

- **Resolver home: `plugin-tree/core`** (the registry owner; lowest feasible layer
  that owns both the tree and `PluginId`). `plugin-id` can't host a node-returning
  resolver — it has no tree, and plugin-tree imports plugin-id (cycle).
- **Fail-loud: throw in `relate()`.** `relate()` runs inside `buildEnrichedTree`,
  which both `./equin build` and the `plugins-doc-in-sync` check call, so a
  throw fails both at the exact site — no new check infrastructure needed.
- **The resolver needs no runtime vocabulary at all** (see below). The runtime
  *grouping* in the facets does, and derives from one browser-safe constant.

### Why the resolver needs zero runtime names

Match the specifier's segments as a **longest-prefix against the real plugin-path
registry** (`tree.byPath`, keyed by `node.path`, which already carries the
`/plugins/` interstitials). Whatever exists in the registry *is* a plugin; whatever
trails it is the barrel suffix — **any name**. The only reserved token is
`"plugins"`, the umbrella nesting interstitial intrinsic to the path encoding
(`asFsPath` joins ids with `/plugins/`):

- `@plugins/page/plugins/editor/server` → longest real path `page/plugins/editor`
  → `{ node: editor, suffix: ["server"] }`. Arbitrary nesting, arbitrary suffix.
- `@plugins/page/plugins/MISSING/server` → longest real path is `page`, next
  segment is `"plugins"` → **`null`** → the throw fires. Broken refs can't pass.
- `@plugins/nope/web` (unknown top-level) → no prefix match → `null` → throw.

So both regexes don't get replaced by a derived list — they **disappear**.
Assumption (already structurally guaranteed): no plugin or barrel folder is named
literally `plugins`.

### Why runtime folders stay a known set (for grouping only)

Runtime folders are a closed, *semantic* vocabulary, not arbitrary labels: the
build routes `web/`→browser and `server/`→Node; the boundary checker enforces
hand-authored isolation; barrel resolution maps `@plugins/x/web`→the web barrel.
The set is also what distinguishes runtime code folders from tooling folders
(`lint/`, `check/`, `bin/`, `plugins/`) — filesystem discovery alone can't. So we
**declare it once** and derive everywhere, rather than discovering it or copying it.

## Implementation

### 1. Canonical browser-safe runtime-folder source — `framework/plugins/plugin-id/core`

`plugin-id` is a dependency-free, browser-safe leaf already owning path/runtime
vocabulary. Add to `core/plugin-id.ts` (export from `core/index.ts`):

```ts
/** The plugin source/barrel runtime folders — the isolation + bundling vocabulary. */
export const RUNTIME_FOLDERS = ["core", "shared", "web", "server", "central"] as const;
export type RuntimeFolder = (typeof RUNTIME_FOLDERS)[number];
```

- `boundaries/core/runtimes.ts`: `runtimeNames` keeps deriving from
  `boundary-config.runtimes` keys (still the permission source). Tighten
  `BoundaryConfig.runtimes` type (`boundaries/core/types.ts:27`) to
  `Record<RuntimeFolder, RuntimeFolder[]>` so the keys are **compiler-guaranteed**
  to equal `RUNTIME_FOLDERS` (boundaries→plugin-id is a new edge; plugin-id is a
  leaf, no cycle). Adding a runtime now requires editing `RUNTIME_FOLDERS` + the
  permission row, and the compiler enforces both.
- Leave plugin-tree's narrower `Runtime` (`web|server|central`, the *executable*
  runtimes for `node.runtimes`) and the unused `RuntimeName` type alone — different
  concept; out of scope. (Note the `RuntimeName` inconsistency as a follow-up.)

### 2. The resolver + `byPath` — `plugin-tree/core/internal/plugin-tree.ts`

- Add `byPath: Map<string, PluginNode>` to the `PluginTree` interface; populate it
  in the Step-2 build loop (`node.path` is set in `collectCoreFields` before tree
  assembly) and include it in the returned literal.
- Add and export from `core/index.ts`:

```ts
const NESTING_SEGMENT = "plugins"; // umbrella interstitial (asFsPath joins with /plugins/)

export function resolvePluginSpecifier(
  tree: PluginTree,
  specifier: string,
): { node: PluginNode; suffix: string[] } | null {
  if (!specifier.startsWith("@plugins/")) return null;
  const parts = specifier.slice("@plugins/".length).split("/");
  let best: PluginNode | undefined;
  let bestLen = 0;
  for (let i = 1; i <= parts.length; i++) {
    const node = tree.byPath.get(parts.slice(0, i).join("/"));
    if (node && i > bestLen) { best = node; bestLen = i; }
  }
  if (!best) return null;
  const suffix = parts.slice(bestLen);
  if (suffix[0] === NESTING_SEGMENT) return null; // points deeper than any real plugin
  return { node: best, suffix };
}
```

No runtime param. Pure registry + structural token.

### 3. `db-schema` facet — resolve to `PluginId`, fail loud

- `core/types.ts`: `EntityExtension.parentPlugin: PluginId`,
  `EntityExtensionRef.childPlugin: PluginId` (import `PluginId` from plugin-id).
  `to-comparable.ts` untouched (it only reads `tables`).
- `facet/index.ts`: delete `pluginModuleRe`. In `relate()`, build
  `byId = Map<PluginId, node>` and key `pluginVarToTable` by `node.id`. Resolve each
  `defineExtension` parent via `resolvePluginSpecifier(tree, ref.parentModule)`;
  **throw** with a clear message (extending plugin id + specifier) if a
  `@plugins/…` specifier returns `null`. Store `parentPlugin = r.node.id`, look up
  the parent table by `r.node.id`, push `extendedBy.childPlugin = node.id`.
  `renderDoc` displays `asPath(parentPlugin)` / `asPath(childPlugin)` (slash form;
  top-level ids are unchanged → zero churn; nested now render e.g. `page/editor`).

### 4. `cross-refs` facet — structured `PluginId`, resolution in `relate()`

Resolution needs the tree, available only in `relate()`. Split the work:

- `core/types.ts`:
  ```ts
  interface ApiUse { plugin: PluginId; symbol?: string }
  interface CrossRefsData {
    apiUses: Record<RuntimeFolder, ApiUse[]>;
    importedBy: PluginId[];
    raw?: Record<RuntimeFolder, { specifier: string; symbol?: string }[]>; // transient, extract→relate
  }
  ```
  Replace the local `RUNTIMES`/`Runtime` with `RUNTIME_FOLDERS`/`RuntimeFolder`.
- `facet/index.ts`: `extract()` scans each `RUNTIME_FOLDERS` dir, records **raw**
  `@plugins/…` import specifiers + symbols (no regex matching of the suffix).
  `relate()` resolves each raw specifier via `resolvePluginSpecifier`, **throws** on
  an unresolvable `@plugins/…` ref, and fills `apiUses[rt] = [{plugin: node.id,
  symbol}]`. **Preserve current same-runtime behavior**: keep an entry only when
  `r.suffix[0] === rt` (the scanned folder) — minimizes doc churn; the broader
  "record cross-runtime imports too" change is noted as a separate follow-up.
  Invert via `byId` into `importedBy.push(importer.id)`. No `split(".")`.
- `core/to-comparable.ts`: iterate `RUNTIME_FOLDERS`; serialize
  `${asPath(u.plugin)}${u.symbol ? "." + u.symbol : ""}`.

### 5. `exports` facet — consume structured cross-refs via `byId`

- `core/types.ts`: `ExportedSymbol.consumers: PluginId[]`; `ExportsData` keyed by
  `RuntimeFolder` (derive from `RUNTIME_FOLDERS`).
- `facet/index.ts`: `relate()` builds `byId`, iterates `xrefs.apiUses[*]` using
  `use.plugin` (a `PluginId`) directly + `byId.get(use.plugin)` — no `indexOf(".")`,
  no `byName`. Push `importer.id` into `consumers`.
- `core/to-comparable.ts`: iterate `RUNTIME_FOLDERS` (accepts that `shared` exports
  now appear in the diff projection — a minor, correct projection change).

### 6. `PluginLink` + render sections — make nested links work (backward-compatible)

`PluginLink` (`plugin-view/web/components/plugin-link.tsx`) takes `name` and passes
it as `pluginId` to the pane *and* renders it — conflating the nav id with the
label. It is also used by **routes** render-detail and (via `ConsumerList`) by
**contributions** render-detail, whose data is still bare-name based and out of
scope. So make the changes **backward-compatible** — never break the `name`-only
signature:

- `PluginLink`: add an optional `label` — `{ name: string; label?: string }`; nav
  uses `name`, display uses `label ?? name`. Existing `name={…}` callers (routes,
  …) are unaffected.
- `ConsumerList` (`plugin-view/web/components/consumer-list.tsx`): render each entry
  as `<PluginLink name={n} label={asPath(n as PluginId)} />`. `asPath` is identity
  on dot-free bare names, so contributions' bare-name `slotContributors` are
  unchanged, while nested PluginIds now display slash-form — a universal improvement
  with **zero caller changes**.

Facet data stores the **dot-form `PluginId`** (canonical; `pluginViewPane` wants the
dot-form hierarchyId for nav). Display is slash-form via `asPath(id)`:
- `db-schema/render-detail/.../db-schema-detail-section.tsx:65,83`: the `PluginLink`
  `name={e.parentPlugin}` now flows a `PluginId`; add `label={asPath(e.parentPlugin)}`.
- `cross-refs/render-detail/.../cross-refs-detail-section.tsx`: the "Uses" group
  (`:74-81`) now maps `ApiUse[]` → display `asPath(u.plugin)` + `.symbol`; importedBy
  `PluginLink` gets `label={asPath(name)}`.
- `exports` render-detail: `consumers` is now `PluginId[]`, passed straight to
  `ConsumerList` (which applies `asPath`). No other change.
- `cross-refs`/`exports` `render-contributions` tables: render `asPath(...)` for the
  plugin part; swap their local `RUNTIMES` arrays for `RUNTIME_FOLDERS`.
- `db-schema`/`exports` markdown `renderDoc` display `asPath(id)`; top-level ids are
  dot-free so existing lines stay byte-identical.

## Out of scope (noted, not done)

- The `["server","central"]` subsets in `routes`/`registrations` facets — a
  *deliberate* semantic subset ("runtimes that host routes/registrations"), a
  different concept from the folder set. Leave alone.
- `boundaries/core/resolve.ts:84` and `plugin-boundaries/check/index.ts:935` — both
  already correct (longest-prefix on `node.path`). **Do not** redirect them to the
  strict resolver: they intentionally tolerate runtime-less imports
  (`runtime: null`) that the strict resolver rejects. Future consolidation only.
- cross-refs same-runtime restriction (drops legit cross-runtime barrel imports) —
  preserved here to bound churn; separate follow-up.
- `RuntimeName` type inconsistency (`boundaries/core/types.ts:21`, unused) —
  follow-up.

## Critical files

- `plugins/framework/plugins/plugin-id/core/plugin-id.ts` (+ `index.ts`) — add `RUNTIME_FOLDERS`/`RuntimeFolder`
- `plugins/framework/plugins/tooling/plugins/boundaries/core/types.ts` — tighten `runtimes` key type
- `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` (+ `index.ts`) — `byPath` + `resolvePluginSpecifier`
- `plugins/plugin-meta/plugins/facets/plugins/db-schema/{core/types.ts, facet/index.ts, plugins/render-detail/web/components/db-schema-detail-section.tsx}`
- `plugins/plugin-meta/plugins/facets/plugins/cross-refs/{core/types.ts, core/to-comparable.ts, facet/index.ts, plugins/render-detail/web/components/cross-refs-detail-section.tsx, plugins/render-contributions/web/cross-refs-facet-table.tsx}`
- `plugins/plugin-meta/plugins/facets/plugins/exports/{core/types.ts, core/to-comparable.ts, facet/index.ts, plugins/render-detail/web/..., plugins/render-contributions/web/exports-facet-table.tsx}`
- `plugins/plugin-meta/plugins/plugin-view/web/components/plugin-link.tsx`

## Verification

1. `./equin build` — regenerates all docs. Expect:
   - **New** lines for previously-dropped nested refs, e.g. in
     `apps/story/marker`'s `CLAUDE.md`: "Entity extension of `page/editor` (table
     `page_blocks_ext_story`)", and the reciprocal "Extended by" on `page/editor`.
   - **Zero churn** on existing top-level entries (`asPath(id)` == bare name for
     top-level plugins).
   - No throw on the current (valid) tree.
2. Confirm fail-loud: temporarily point a `defineExtension`/import at
   `@plugins/page/plugins/does-not-exist/server` → `./equin build` (or
   `./equin check plugins-doc-in-sync`) must **fail** with the clear message.
   Revert.
3. `./equin check` — `plugin-boundaries` (confirms the new
   facets→plugin-id / boundaries→plugin-id edges are legal and no cycle),
   `plugins-doc-in-sync`, `eslint`, `typescript` all green.
4. Studio → a nested plugin's detail pane: the cross-refs "Imported by" / db-schema
   "Extends/Extended by" chips now resolve and **navigate** to the correct nested
   plugin (previously the `PluginLink` label-as-id bug broke nested nav).
5. Add a unit-style check (or a scratch script) exercising `resolvePluginSpecifier`
   on: top-level, nested, deeply-nested, missing-nested (→ null), unknown-top (→
   null), and a deep barrel path (`@plugins/x/web/components/y` → node x).

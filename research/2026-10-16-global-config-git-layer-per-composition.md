# The bundled config layer, scoped to its composition

Track: "Demos and client server" (wiki `block-3e397e42-8412-4895-b854-e620a1b4f789`).
Parent: `research/2026-10-16-global-config-git-layer-in-browser-server.md` (§2, "Build emits the
resolved layer into config_v2's web artifact").

## Context

`./singularity build` bundles the committed config layer for the browser server. Codegen
(`tooling/plugins/codegen/core/config-git-layer-gen.ts`) walks the whole repo `config/` and writes
ONE gitignored module, `plugins/config_v2/web/internal/git-layer.generated.ts`. `demo-resource.ts`
reaches it through `import("./git-layer.generated")`, so it is a lazy chunk **inside config_v2's web
artifact**.

Web artifacts are content-addressed per plugin and shared by every composition that contains the
plugin. So the website composition's dist carries the committed config of Mail, Places, Pages,
etc.: apps it does not contain. The chunk is lazy, but it is still a public static file of the
deploy.

**Goal:** a composition's build carries only the committed config of the plugins that composition
contains. Personal content inside included plugins (prompt templates, …) is a separate decision and
out of scope.

## Design

The build already has exactly one per-composition web artifact: the **registry artifact**. It sits
behind the fixed `@composition-web-registry` import-map specifier and is built per composition from
`web.generated.ts` (main) or `web.composition.<name>.generated.ts` (gitignored). Today it holds
composition-scoped code. This change makes it hold composition-scoped data too. The config layer
becomes a second file of that same artifact, behind a second fixed specifier,
`@composition-config-layer`.

As a result, config_v2's artifact no longer depends on `config/` at all. It is identical across
compositions again, and a config edit stops rebuilding it. Only the registry artifact rebuilds, and
that build is a cheap esbuild type-strip.

### 1. Filtering rule: which documents a composition carries

A storePath is `<asPath(pluginId)>/<name>.jsonc`, and its directory is the plugin that owns the
descriptor. That is also true for `pluginId` overrides: reorder files a slot's directive under the
slot's *defining* plugin, which must be loaded for the slot to exist.

- **Keep a document** iff that plugin id is in the composition's **web registry**, meaning its
  `webEntries` ids. The demo serve answers only web-registered descriptors
  (`ConfigV2.WebRegister`), so the web closure is the exact set, not a proxy for it.
- **Keep an `@app/<id>` scope** iff `<id>` is an app the composition's bundle declares. For example,
  the `ui/theme-engine/@app/mail` scope is dropped from a composition without Mail. If a document
  loses all its scopes and has no honored override, it is dropped (the existing "arranged" rule).

The app ids come from the registry's plugins too. For each `webEntries` plugin, the git-layer step
reads its `core/` for a `defineApp({ id })` call, using `readDefineAppIn` (declared-apps.ts). This
is the same static scanner `readDeclaredApps` and composition `home` resolution use. So each
registry fully describes what its composition contains, the step needs no plugin-tree walk, and no
data is threaded between build stages.

*(As built: the first draft added an `apps` field to the registry's `composition` export instead.
That was dropped because it would have churned all ~10 committed generated registries for a value
only a build step reads.)*

### 2. Codegen: one layer file per resident registry (stage 2)

`generateConfigGitLayer({ root })` stays where it is: stage 2, after `seedAuthoredOverrides`. It
must stay there, because it reads the origins and the seeded overrides that stage 2 writes. It now
works like this:

- It enumerates the registries this checkout holds: main's committed `web.generated.ts` plus every
  `listNamedCompositionRegistries(root)` entry. That is the same "resident" set that stage 1 just
  regenerated, so no composition's layer goes stale.
- For each registry, it imports it (as `compositionFleetSource` already does), reads the
  `webEntries` ids, and reads the app ids those plugins declare.
- It runs `collectConfigGitLayer(root, { plugins, apps })` (a walk of `config/`) once per
  registry: the same resolution (`resolveGitLayer`), with the §1 filter applied to it.
- It writes `config-layer.<name>.ts` per composition into the gitignored repo-root
  `.generated/composition-modules/`. The name comes from `compositionConfigLayerFileName(name)` in
  `web-artifacts/core/composition-modules.ts`, so codegen and the fleet planner cannot disagree on
  it.
  - **Outside `plugins/`, on purpose (as built).** The first draft put the files beside the web
    registries in `web-sdk/core/`. The build then failed `plugins-doc-in-sync`, because plugin-tree
    scanners walk a plugin's runtime folders on disk. The token-usage facet read config text such as
    `--shadow` as web-sdk's own styling source, but only once a build had written the file, so the
    generated docs depended on build order. The artifact own-file hash would also have moved
    web-sdk/core's address on every config edit.
- **The generated module imports nothing.** It exports `gitLayer` with an inline structural type,
  because nothing resolves `@plugins/*` for a file outside the tree. config_v2 types the seam itself.
- It deletes `plugins/config_v2/web/internal/git-layer.generated.ts` and its `.gitignore` line.

`build` and `release --hermetic` both run stage 2, so both produce the files before stage 3.

### 3. Web artifacts: the registry artifact carries the layer

In `tooling/plugins/web-artifacts/core/internal/`:

- **`plan.ts`:**
  - `FleetSource` gains `configLayerFile`. `defaultFleetSource` and `compositionFleetSource` fill it
    from `compositionConfigLayerFileName`, and a missing file throws, as a missing registry does.
  - `registryInputsHash` hashes `registrySource + configLayerSource`, so a config edit re-addresses
    the registry artifact.
  - `composeMapEntries` adds `@composition-config-layer` → `/artifacts/<registryDir>/config-layer.js`.
- **`vite-builder.ts` `buildRegistryArtifact`:** type-strips the layer file into `config-layer.js`
  next to `index.js`, with the same esbuild transform and sourcemap.
- **`externals.ts` / `constants.ts`:** wherever `@composition-web-registry` is special-cased, check a
  `COMPOSITION_SPECIFIERS` list (both specifiers) instead, so the two can't drift.
- **`expected.ts`:** check that the registry dir also lists `config-layer.js`.

### 4. config_v2 reads the seam

- In `demo-resource.ts`, `loadBundledGitLayer` becomes
  `import("@composition-config-layer").then((m) => m.gitLayer)`. It is still lazy: the main app never
  fetches it, and a demo fetches it from its own composition's registry artifact.
- The type comes from a hand-written ambient declaration, `config_v2/web/internal/composition-config-layer.d.ts`
  (`declare module "@composition-config-layer" { export const gitLayer: GitLayer }`), not a tsconfig
  path to a gitignored file. A side effect is that a fresh clone's `tsc` no longer fails before the
  first build, which was the "Fresh clone (as landed)" wart in the parent doc.
- Vite/vitest resolution:
  - root `vitest.config.ts` and `layout-harness/web/internal/build-measurer-page.ts` alias the
    specifier to a small committed empty-layer fixture (`export const gitLayer = {}`);
  - tests keep injecting `LoadGitLayer`.

### Not in scope

- What committed config a public demo may show from included plugins (the owner's prompt templates).
  That stays an open Gap on the track card.
- The server side. The host server reads `config/` directly and is not shipped to the website.

## Files

- **Edited:**
  - `tooling/plugins/codegen/core/config-git-layer-gen.ts` (+test)
  - `declared-apps.ts` (`readDefineAppIn`)
  - `plugin-registry-gen.ts` (the vendor scan skips composition specifiers)
  - the web-artifacts files: `plan.ts` (+test), `vite-builder.ts`, `externals.ts`, `constants.ts`,
    `expected.ts`
  - `config_v2/web/internal/demo-resource.ts`
  - `vitest.config.ts`
  - `build-measurer-page.ts`
  - `.gitignore` (`/.generated/`)
  - `config_v2/CLAUDE.md`
  - `app-artifacts.ts`, the stage-2 comment
  - the parent doc's §2
- **New:**
  - `web-artifacts/core/composition-modules.ts`: the specifiers, `COMPOSITION_SPECIFIERS`, and
    `compositionConfigLayerFileName`
  - `config_v2/web/internal/composition-config-layer.d.ts`
  - the empty-layer fixture

## Verification

- `./singularity test plugins/framework/plugins/tooling/plugins/codegen plugins/framework/plugins/tooling/plugins/web-artifacts plugins/config_v2`:
  - **Generator, on a temp `config/` tree:**
    - a document whose plugin is outside the registry is dropped;
    - an `@app/<id>` scope for an app outside the composition is dropped;
    - a document left with neither an override nor a scope is dropped;
    - main (full registry) keeps today's output.
  - **plan:**
    - the registry `inputsHash` changes when only the layer file changes;
    - the import map has `@composition-config-layer` under the registry dir;
    - a composition source with no layer file throws.
- `./singularity build`, then a screenshot of `/demo`: the Agent Manager sidebar still shows its
  committed views (Queue, Models, …).
- `./singularity build --composition website`. In that composition's dist:
  - the registry artifact's `config-layer.js` names no `apps/mail`, `apps/places` or `apps/pages`
    storePath and no `@app` scope for them;
  - main's `config-layer.js` does;
  - no file in config_v2's artifact contains config data (grep for `conversations-sidebar`).
- `./singularity check` is green: plugin-boundaries, type-check, `plugins-registry-in-sync`.
- Afterwards, on the track card: tick a "per-composition config" line and rewrite the config
  paragraph. Then file the next main task: the `turn-ledger.turns` demo answer.

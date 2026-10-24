# A browser-built file reaches a sibling folder of its own plugin only through that folder's barrel

## Context

`theme-engine/web/components/theme-injector.tsx` imported `mergeGroupValues`
from `../../core/merge-group-values` — a file inside the plugin's own `core/`,
not re-exported by `core/index.ts`. `./equin check` was green (type-check,
eslint, plugin-boundaries). `./equin build` then failed ~5 minutes in, at
the web-artifacts compose step:

```
"@plugins/ui/plugins/theme-engine/core" does not export "mergeGroupValues"
(imported by artifacts/ui.theme-engine.web.<hash>/index.js)
```

Why: the web-artifact builder (`ownFolderBarrelPlugin` in
`web-artifacts/core/internal/vite-builder.ts`) routes EVERY import that lands in
one of the plugin's own non-inlined folders — the barrel and any deep file — to
that folder's external `@plugins/<own>/<folder>` barrel. It must: inlining a
private copy of `core/x` next to the core artifact everyone else loads would
double-instantiate its module state (one URL = one module instance). So in the
browser a deep import means "the barrel", while `tsc` and every check read it as
"that file". The two views agree only when the symbol happens to be in the
barrel, and nothing before compose compares them.

Nothing polices it today: `plugin-boundaries` short-circuits intra-plugin edges
(`check/index.ts`, "Intra-plugin imports … are unrestricted"), and the
`runtime-isolation` lint rule only bans `web|core → server` / `server → web`.

The theme-engine instance is already fixed (the barrel now exports it). A live
one is waiting: `review/plugin-changes/shared/resources.ts` imports
`PluginChangesSchema` from `../core/protocol`, which its barrel does not export —
it only has not failed because that plugin is excluded from the build.

## Approach

Make the deep spelling a lint error in exactly the files the browser build
rewrites. Once the import names the barrel, `tsc` sees what the bundler sees, so
a missing export becomes an ordinary type error in the editor (rung 3 → rung 2).

### 1. Lint rule `runtime-isolation/no-deep-own-folder-import`

Sibling of `no-cross-runtime-import`, in
`plugins/framework/plugins/tooling/plugins/lint/plugins/runtime-isolation/lint/`.

- **Importer scope** (user decision: browser-built only): files in the plugin's
  own `web/`, `core/`, `shared/`, `fixtures/` — the folders that ship in browser
  artifacts (`web`/`core`/`fixtures` are the artifact kinds; `shared` is inlined
  into each). Server/check/cli/scripts files keep reaching into
  `core/internal/…`: Bun resolves the file itself, so there is no mismatch.
- **Flagged**: an import / `export … from` / `import()` whose target is inside
  the SAME plugin, in a folder other than the importer's own, other than
  `shared/` (inlined, often barrel-less), `plugins/` (other plugins) and
  `node_modules/`, and which names anything deeper than the folder's barrel.
  Barrel spellings accepted: `../core`, `../core/index`, `../core/index.ts`,
  `@plugins/<own>/core`. Both relative and own-`@plugins` self-specifiers are
  covered. Type-only imports included (same argument as the sibling rule: a
  type crossing a folder is that folder's public API).
- **Autofix**: rewrite the specifier to the barrel in the same spelling
  (relative stays relative). This is exactly the module the browser already
  loads, so the fix is behaviour-preserving for the bundle; `tsc` then names any
  symbol the barrel is missing.
- Message says the import is rewritten to the barrel in the browser build, and
  the fix is to import the barrel and export the symbol from `<folder>/index.ts`.
- Shared helpers (`locate`, `pluginDirEnd`, `resolveRelative`, `toPosix`) move
  to one internal file both rules import, so the plugin-dir grammar has one
  spelling.
- Stays off in test/e2e files (the default for contributed rules): they are
  never bundled.

### 2. Migrate the existing 69 imports

Run the autofix. 68 are path-only; `review/plugin-changes/core/index.ts` gains
`PluginChangesSchema`. Any type the autofix exposes as missing from a barrel is
added there.

### 3. Builder: refuse instead of silently rewriting

In `ownFolderBarrelPlugin`, a DEEP path into a non-inlined own folder throws,
naming the importer, the specifier and the lint rule; only barrel paths are
rewritten. With the rule in place this fires only for what lint cannot see
(`*.generated.ts`, `eslint-disable`, `--skip-checks`), and it fires at the
per-plugin build naming the source file, instead of at compose naming a hashed
artifact. Update the invariant in `web-artifacts/CLAUDE.md` and the doc comment.
(Editing the builder's `core/` bumps `builderSourceDigest` — one fleet rebuild.)

## Files

- `plugins/framework/plugins/tooling/plugins/lint/plugins/runtime-isolation/lint/`
  — new rule + test, shared internal helpers, barrel entry; plugin `CLAUDE.md`.
- `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/vite-builder.ts`
  + `CLAUDE.md`.
- ~40 plugin files under `web/`, `shared/` (specifier-only changes), e.g.
  `primitives/live-state/web/*.ts`, `infra/endpoints/web/internal/*.ts`,
  `build/shared/index.ts`; `review/plugin-changes/core/index.ts`.

## Verification

- `./equin test` on the runtime-isolation plugin: RuleTester cases —
  deep relative / deep self-specifier from `web`/`shared` flagged with the barrel
  fix; barrel spellings, `shared/` targets, same-folder, server importers and
  cross-plugin imports pass.
- Repro: a scratch deep import of a non-barrel core symbol in a web file fails
  `./equin check type-check` at lint; after the autofix it fails at tsc
  with "has no exported member". Revert.
- `./equin check` green; `./equin build` OK.

# No free plugin folders

## Context

The boundary checker decides what a file may import from the folder it sits in
(`web/`, `server/`, `core/`, …), using the `runtimes` table in
`boundaries/boundary-config.ts`. A file in a folder with no row, or a loose file at
a plugin's root, resolves to "no folder" (`runtime: null`), and `checkRuntime`
returns `true` for it (`boundaries/core/evaluate.ts`). So today these are free to
import any folder of any plugin:

| folder | files | measured imports today |
|---|---|---|
| `lint/` | 267 | core |
| `check/` | 148 | core, server, data-dirs, own shared |
| `facet/` | 15 | core, one `paths/server` |
| `bin/` | 21 | core, server, central, cli, data-dirs, own shared |
| `scripts/` | 17 | core, server, data-dirs, own shared |
| `fixtures/` | 18 | web, core |
| `vite/` | 2 | nothing |
| `prewarm/` | 2 | core, own shared |
| loose root files | 2 | `boundaries/boundary-config.ts`, `migrations/drizzle.config.ts` |

(The page card counted one `check → cli` import; it is actually
`cli/plugins/check/cli/run.ts`, a `cli/` folder inside a plugin named `check`.
`check/` needs no `cli`.)

Root cause: the list of legal folders and the list of rule rows are two
separate lists. The legal folders are `standardDirsWith` in
`codegen/core/plugin-registry-gen.ts` (hardcoded `core, shared, plugins, bin,
scripts, e2e` plus every `defineCollectedDir("x")` found by a text scan). The rows
are the `runtimes` map. Nothing makes them agree.

Goal: one list. A folder cannot be declared without its row, and every file inside
a plugin resolves to a folder with a row or is reported. `plugins/` is the one
name that is not a folder of code: it holds child plugins.

## Design

### 1. One folder vocabulary, in `plugin-id/core` (type-enforced)

`plugin-id/core/plugin-id.ts` already owns `RUNTIME_FOLDERS`, the barrel folders
(cross-plugin import entry points), and derives everything else from it. Add the
leaf folders beside it:

```ts
export const LEAF_FOLDERS = ["check", "lint", "facet", "bin", "scripts", "fixtures", "vite", "prewarm"] as const;
export type LeafFolder = (typeof LEAF_FOLDERS)[number];
export const PLUGIN_FOLDERS = [...RUNTIME_FOLDERS, ...LEAF_FOLDERS] as const;
export type PluginFolder = RuntimeFolder | LeafFolder;
```

A leaf folder is found by discovery (a collected-dir loader, a process entry
point, a script run by path). Nothing imports it. `RUNTIME_FOLDERS` keeps its
current meaning, so the export/cross-ref facets, `SHIPPED_*`, `UNDOCUMENTED_*` and
`RUNTIME_COLORS` do not change.

This deliberately differs from the page card, which proposed putting each row in
its `defineCollectedDir("check", { imports })` call. That would still leave two
sources (`core`, `shared`, `bin`, `scripts`, `e2e` are not collected dirs), and
the boundary checker would have to recover the rows by scanning source text. One
typed table has neither problem.

### 2. The boundary table is exhaustive over folders and cannot target a leaf

In `boundaries/core/types.ts`, rename `runtimes` to `folders` and type it:

```ts
folders: Record<PluginFolder, RuntimeFolder[]>;
```

- `Record<PluginFolder, …>`: adding a folder name without a row is a tsc error.
- The value type is `RuntimeFolder[]`: no row can list a leaf, so "nothing imports
  `check/`, `lint/`, `bin/`, …" is a type fact, not a convention.
- `runtimeNames` (`boundaries/core/runtimes.ts`, used by plugin-boundaries R4 as
  the legal `@plugins/<p>/<folder>` endings) derives from `RUNTIME_FOLDERS`
  instead of the table's keys. So `@plugins/x/check` stays an illegal specifier.

New rows (measured, per the card):

```ts
lint:     ["core"],
check:    ["core", "shared", "data-dirs", "server"],
facet:    ["core"],                 // see "known breaks"
bin:      ["core", "shared", "data-dirs", "server", "central", "cli"],
scripts:  ["core", "shared", "data-dirs", "server"],
fixtures: ["web", "core"],
vite:     ["core"],
prewarm:  ["core", "shared"],
```

`shared` in a row means the plugin's own `shared/`; plugin-boundaries R10
already forbids reaching another plugin's. `web` is in no host-process row.
(`facet` gets `core` only. Its one `paths/server` import moves to `paths/core`,
which exports the same `PLUGINS_DIR`. It does not need `data-dirs`.)

### 3. The legal-folder list is the vocabulary

In `codegen/core/plugin-registry-gen.ts`, `standardDirsWith` becomes
`new Set([...PLUGIN_FOLDERS, "plugins"])`. The discovered collected dirs no longer
widen it. Instead, every discovered `defineCollectedDir` name must be a member of
`PLUGIN_FOLDERS`, and discovery throws naming the file if not (fails the build).

`collected-dir/core/define.ts`: `defineCollectedDir(dir: PluginFolder)`, so a
typo or an undeclared name is a tsc error at every typed call site. `lint/core`
keeps its inline marker (jiti cannot resolve aliases). The discovery throw
covers it.

Adding a new kind of folder is now one edit to `LEAF_FOLDERS` (or
`RUNTIME_FOLDERS`). tsc then asks for its row.

### 4. The resolver never returns "no folder"

`boundaries/core/resolve.ts`: `resolveFile` returns a discriminated result instead
of `{ runtime: string | null } | null`:

```ts
type Resolved =
  | { kind: "outside" }                                  // not under plugins/ (npm, eslint.config.ts…)
  | { kind: "folder"; zone: string; folder: PluginFolder }
  | { kind: "unfoldered"; zone: string; why: "loose-file" | "unknown-folder" | "not-in-child-plugin"; name: string };
```

- `loose-file`: a file directly in a plugin directory.
- `unknown-folder`: the first segment is not in `PLUGIN_FOLDERS`.
- `not-in-child-plugin`: the first segment is `plugins/` but the file is not in
  any discovered child plugin (no barrel). This is how `plugins/` stays the only
  exception: it is a container, and code sitting in it directly is reported too.

`resolveImport` returns the same type for relative and `@plugins/…` specifiers.

`check.ts`:
- A source file that resolves `unfoldered` gets one violation (with the reason
  and the legal folder list), and its imports are not evaluated.
- An import whose target resolves `unfoldered` is a violation. For example, a
  relative import of a loose root file, or `@plugins/x` with no folder.
- `checkRuntime(folders, source: PluginFolder, target: PluginFolder)` loses its
  `null → true` fallback. Both arguments are non-null by type.
  `isRuntimeException` likewise.

The boundaries `resolve.test.ts` gains cases: a loose root file, an unknown
folder, a file under `plugins/` outside any child, a leaf folder source, and an
import into a leaf (denied).

### 5. Known breaks, fixed in the same change

1. **`facet/` → `paths/server`**: `facets/plugins/structure/facet/index.ts`
   imports `PLUGINS_DIR` from `@plugins/infra/plugins/paths/core`.
2. **`boundaries/boundary-config.ts`** moves to `boundaries/core/boundary-config.ts`
   (it is plain data that imports `./config`, and it fits the core row). Update the
   two importers (`core/runtimes.ts`, `core/boundary-rules-check.ts`), the root
   `CLAUDE.md` "exact exempt set" link, the boundaries `CLAUDE.md`, and the comment
   references in the live code (`plugin-id.ts`, `browser-fetch`, `e2e-harness`,
   `no-plugin-imports-in-core`). Research docs are historical and are left alone.
3. **`migrations/drizzle.config.ts`** moves to `migrations/core/drizzle.config.ts`.
   drizzle-kit only looks for `drizzle.config.ts` in its cwd when it gets no
   `--config`. `core/internal/drizzle-cli.ts` already owns the argv and already
   supports `--config=`. It now always passes `--config=core/drizzle.config.ts`,
   as a constant next to the `generate` literal. The child's cwd stays the
   migrations dir, so `out: "./data"` and the `REPO_ROOT_FROM_MIGRATIONS_DIR`
   glob prefix stay correct. (Verify that drizzle-kit resolves `out`/`schema`
   against cwd and not the config's directory. If it resolves them against the
   config's directory, adjust the prefix by one level.) The
   `drizzle-config-schema-globs` check imports `../core/drizzle.config`. Caveat:
   this is Node-only code in `core/`, which is the "core means two things" issue
   already parked on the page. Nothing imports it from web.
4. Anything else the stricter resolver turns up (e.g. an `@plugins/x` bare import
   or a relative `package.json` import) is fixed at its site, or listed back to
   you if it isn't mechanical. The initial measurement found none.

### 6. Docs

- The boundaries `CLAUDE.md` gets a short "Folders" section: the vocabulary lives
  in `plugin-id/core`, every folder has a row, leaves are never targets, and a
  file with no folder is a violation.
- Rewrite the `provision` row comment in the config that describes the
  `checkRuntime`-returns-true hole, since that hole is gone.
- `./equin build` regenerates `plugins-details.md` and the plugin
  `CLAUDE.md` reference blocks.

## Critical files

- `plugins/framework/plugins/plugin-id/core/plugin-id.ts` (+ barrel): `LEAF_FOLDERS`, `PluginFolder`
- `plugins/framework/plugins/tooling/plugins/boundaries/{boundary-config.ts → core/boundary-config.ts, core/types.ts, core/resolve.ts, core/evaluate.ts, core/check.ts, core/runtimes.ts, core/resolve.test.ts, CLAUDE.md}`
- `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts` (`standardDirsWith`, discovery membership throw)
- `plugins/framework/plugins/tooling/plugins/collected-dir/core/define.ts`
- `plugins/plugin-meta/plugins/facets/plugins/structure/facet/index.ts`
- `plugins/database/plugins/migrations/{drizzle.config.ts → core/drizzle.config.ts, core/internal/drizzle-cli.ts, check/drizzle-config-schema-globs.ts}`
- root `CLAUDE.md`

## Verification

1. `./equin test plugins/framework/plugins/tooling/plugins/boundaries plugins/framework/plugins/tooling/plugins/codegen`: the new resolver cases, plus the collected-dir discovery tests (including a new one where an undeclared collected-dir name throws).
2. `./equin check boundary-rules plugin-boundaries type-check database-migrations:drizzle-config-schema-globs migrations-in-sync plugins-registry-in-sync plugins-doc-in-sync`: all green.
3. Negative probes, by hand and then reverted: a `check/` file importing
   `@plugins/x/web`, a `fixtures/` file importing `server`, a new
   `plugins/x/foo.ts` loose file, and a `plugins/x/misc/a.ts` unknown folder. Each
   must fail `boundary-rules` with the new message.
4. `./equin build` (background): migration generation must still work
   through the moved drizzle config. Make a no-op check that `drizzle-kit
   generate` reports no changes.

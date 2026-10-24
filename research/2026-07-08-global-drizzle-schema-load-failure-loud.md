# Fail loudly when a drizzle schema file can't be synchronously loaded

## Context

drizzle-kit discovers tables by a filename glob (`server/**/internal/{tables,tables-*,schema,schema-*}.ts`) and loads each matched file through a **synchronous CJS `require()`** (running under `bun x --bun drizzle-kit generate`). When a schema file's import graph pulls in an async-only module — one with top-level await, e.g. `lexical` / `@lexical/yjs` (typically reached transitively through a plugin barrel) — the sync `require()` throws:

```
TypeError: require() async module … unsupported
```

drizzle-kit prints the error but **exits 0**. The build then treats that schema file as if it defined no tables: the migration for a brand-new table is silently dropped, `migrations-in-sync` passes (it only diffs the *set of generated `.sql` filenames*, and none was generated), and the table vanishes with zero signal — the same failure class as the earlier `bunx→node→Bun.which` silent-exit-0 already documented in `migrations.ts`.

### Why the existing guard misses it

`generateMigration` (`plugins/framework/plugins/cli/bin/migrations.ts:535-544`) already has a "printed a diagnostic but exited 0 → fail" guard:

```ts
if (result.exitCode !== 0) process.exit(1);
if (/\b(error|collision|conflict)\b/i.test(result.stderrBuf)) { … process.exit(1); }
```

It fails on two counts here:
1. It scans **only `stderrBuf`** — the require() diagnostic can land on stdout.
2. The whole-word regex `/\b(error|collision|conflict)\b/i` matches neither `TypeError` (no word boundary before `Error`) nor `require() async module … unsupported`.

### Intended outcome

A schema-glob file that drizzle-kit cannot load must **fail the build/check loudly**, naming the offending file — never be silently skipped. Fix the class structurally (an independent invariant), plus harden the wrapper's detector as defense-in-depth. Confirmed approach: **check + detector**, with the schema-glob enumeration **extracted to a shared core barrel**.

## Design

Three coordinated changes:

### 1. Extract schema-glob enumeration to a shared core barrel (single source of truth)

`parseSchemaGlobs` + `computeGlobFiles` currently live inline in `table-defs-in-schema-glob/check/index.ts`. Extract them into a new **`plugins/database/plugins/migrations/core`** barrel (co-located with `drizzle.config.ts`, the single source of the glob):

- New `plugins/database/plugins/migrations/core/internal/schema-glob.ts`:
  - `parseSchemaGlobs(configText: string): string[] | null` — moved verbatim.
  - `schemaGlobFiles(root: string): string[]` — reads `drizzle.config.ts`, parses the `schema:` array, expands each config-relative pattern via `Bun.Glob(...).scanSync({ cwd: root })`, returns **repo-relative** paths (the current `computeGlobFiles` logic, plus the `MIGRATIONS_PLUGIN_DIR` constant). Throws loudly if the array can't be parsed (fail closed).
- New `plugins/database/plugins/migrations/core/index.ts` barrel re-exporting both (barrel-purity: imports + re-exports of own internal files only).
- Refactor `table-defs-in-schema-glob/check/index.ts` to `import { parseSchemaGlobs, schemaGlobFiles } from "@plugins/database/plugins/migrations/core"` and delete its inline copies (keep `MIGRATIONS_PLUGIN_DIR`/`DRIZZLE_CONFIG` only if still referenced elsewhere in that file). Behavior must stay pixel-identical — this check's semantics don't change.

Boundary note: the new edge `framework/tooling/checks/table-defs-in-schema-glob → database/plugins/migrations/core` is legal (barrel import) and acyclic — the glob helper imports only `fs`/`path`/`Bun`.

### 2. New structural check: `schema-files-loadable` (the guarantee)

Add to the existing exported array in **`plugins/database/plugins/migrations/check/index.ts`** (`export default [check, orphanedTablesCheck, imperativeCreateTableAllowlistedCheck, schemaFilesLoadableCheck]`) — no new plugin, no registry edit; the `database.migrations` collected-dir entry already exists.

The check asserts the invariant drizzle-kit silently relies on: **every schema-glob file is synchronously `require()`-able under Bun.**

- Enumerate files via `schemaGlobFiles(root)` (§1).
- Run **one** subprocess that replicates drizzle-kit's load: `bun --bun <probe.ts> <absFile...>`, cwd = `plugins/database/plugins/migrations` (matches drizzle-kit's module/tsconfig-path resolution), env includes `SINGULARITY_WORKTREE` (as `migrations-in-sync` does). Probe is a small committed helper (`check/internal/require-probe.ts`) that, per file, `try { require(f) } catch (e) { record(f, String(e)) }`, then writes JSON failures to stdout. A `.ts` file whose graph contains top-level await throws exactly the observed error, so this is faithful; if drizzle-kit's loader ever diverges, the check stays a conservative guard (sync-requireability is precisely the property drizzle needs).
- Result: `{ ok: false, message }` listing each unloadable file + its error, with a `hint` explaining the cause (an async-only/top-level-await module in the schema file's import graph — e.g. a barrel pulling in `lexical`/`@lexical/yjs`) and the fix (keep `tables.ts` a leaf importing only sync modules; move the async import out of its graph). `{ ok: true }` otherwise.
- `alwaysRun: true` — so it guards even `./equin build --skip-checks` (this is the sanctioned use per the `Check.alwaysRun` doc: a cheap structural invariant painful to discover only at push). Leave `cacheSignature` default (pure function of tree content; the lockfile is in-tree, so dep changes reprovoke it).

### 3. Harden `generateMigration`'s detector (defense-in-depth)

In `plugins/framework/plugins/cli/bin/migrations.ts` (after the existing `exitCode`/stderr guards, ~line 544), add a targeted scan of **both** streams for schema-load-failure signatures — keeping the existing stderr-only `error|collision|conflict` untouched to avoid stdout false positives:

```ts
const combined = `${result.stdoutBuf}\n${result.stderrBuf}`;
if (/require\(\) async module|async module.*unsupported|\bTypeError\b|Cannot find module|Cannot use import statement/i.test(combined)) {
  console.error(
    "\nError: drizzle-kit exited 0 but failed to load a schema file — the table(s) it\n" +
    "defines would be SILENTLY DROPPED from migration generation. A schema-glob file\n" +
    "(server/**/internal/{tables,schema}.ts) has an async-only module (top-level await,\n" +
    "e.g. lexical/@lexical/yjs) in its import graph. Fix the offending import; run\n" +
    "`./equin check schema-files-loadable` to see exactly which file.",
  );
  process.exit(1);
}
```

This catches the failure at the point of generation. The §2 check remains the real guarantee (independent of drizzle-kit's output text).

## Files to modify

- **New** `plugins/database/plugins/migrations/core/index.ts` — barrel.
- **New** `plugins/database/plugins/migrations/core/internal/schema-glob.ts` — `parseSchemaGlobs`, `schemaGlobFiles`.
- **New** `plugins/database/plugins/migrations/check/internal/require-probe.ts` — the `bun --bun` require probe.
- `plugins/database/plugins/migrations/check/index.ts` — add `schemaFilesLoadableCheck` (`internal/schema-files-loadable.ts` or inline) to the default-export array.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/table-defs-in-schema-glob/check/index.ts` — consume shared helpers, drop inline copies.
- `plugins/framework/plugins/cli/bin/migrations.ts` — extend the diagnostic guard.
- `plugins/database/plugins/migrations/CLAUDE.md` — one line documenting the `schema-files-loadable` invariant (schema files must be leaf/sync-requireable).

## Verification

1. **Clean tree passes:** `./equin build` (regenerates docs + runs checks). Then `./equin check schema-files-loadable` and `./equin check table-defs-in-schema-glob` both pass (the refactor is behavior-preserving).
2. **Reproduce the footgun (temporary):** add an async-only import to a real schema file — e.g. in a throwaway `plugins/<x>/server/internal/tables.ts`, `import "@lexical/yjs"` alongside a `pgTable(...)` — then:
   - `./equin build` must now **exit non-zero** at migration generation (the §3 detector), naming the schema-load failure — instead of silently reporting "no schema change".
   - `./equin check schema-files-loadable` must **fail** and name that exact file.
   - Revert the temporary import; both go green again.
3. **Pure unit test** (optional, `bun:test`): co-locate `schema-glob.test.ts` next to `internal/schema-glob.ts` asserting `parseSchemaGlobs` extracts the four patterns from a sample config and returns `null` on a malformed one.
4. Run full `./equin check` to confirm no boundary/doc/registry check regressed (new `core` barrel covered, docs in sync).

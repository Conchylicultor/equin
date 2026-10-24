# Single source of truth for the drizzle schema glob

**Date:** 2026-07-29
**Category:** global (`plugins/database/plugins/migrations` + `plugins/framework/plugins/tooling`)

## Context

`plugins/database/plugins/migrations/drizzle.config.ts` declares the `schema: [...]`
glob array that decides which files drizzle-kit discovers for migration generation.
That array is read by **two independent mechanisms that can silently disagree**:

1. **drizzle-kit** — loads the module and uses the real evaluated array. Authoritative.
2. **`core/internal/schema-glob.ts`** — reads the file as *text* and regexes the array out:
   ```ts
   configText.match(/schema\s*:\s*\[([^\]]*)\]/)
   [...body.matchAll(/["'`]([^"'`]+)["'`]/g)]
   ```

Nothing forces the two to agree. A **total** parse failure is safe (`parseSchemaGlobs`
returns `null`, `schemaGlobFiles` throws — fail closed). The dangerous case is a
**partial** match, which returns a plausible subset with no error:

- The regex matches the first `schema:` + `[` anywhere in the file *including inside a
  comment* — prose mentioning the old form hijacks the parse. The file currently carries
  a hand-written `NOTE:` telling future editors not to write that pattern in prose: a
  footgun **documented rather than removed**.
- `[^\]]*` stops at the first `]`, so a glob containing a character class truncates the
  array body.
- The string-literal extractor silently skips any non-literal element (a spread, a
  variable, a `.map()`), yielding a subset rather than an error.

`schemaGlobFiles` is the declared "single source of truth for which files drizzle-kit
discovers", consumed by the `schema-files-loadable` and `table-defs-in-schema-glob`
checks — both of which exist to catch a table silently vanishing from migration
generation. If the text parse yields a subset, those checks inspect **fewer files and
keep passing** while the invariant they protect is violated. A guard that reports green
on a narrowed domain is worse than no guard.

**Outcome:** delete the text parsing entirely. One declaration of the glob set, consumed
by both readers, with the agreement *proved by a check* rather than asserted in prose.

## Key findings from investigation

These shaped the design and are worth recording:

- **drizzle-kit loads the config via a synchronous CJS `require()`** with an
  esbuild-register TS hook (`drizzleConfigFromFile` in `bin.cjs`, drizzle-kit 0.28.1) —
  not a bundle, not jiti. Nested imports inside the config resolve and execute normally,
  **subject to the same "must be synchronously loadable, no top-level await" constraint**
  already documented for schema files. Precedent: before commit `8986bc2d0` the config
  imported `@plugins/database/core` (a tsconfig-path-aliased specifier — strictly harder
  than a relative one) and worked.
- **`defineConfig` is literally `(config) => config`** — a 7-line module with no
  transitive weight. Importing the config from a check is nearly free.
- **The globs are cwd-anchored, not config-anchored.** Both sanctioned drizzle-kit
  invocations set `cwd` to the migrations plugin dir. Proof: `migrations-in-sync` writes a
  temp config one directory *deeper* (`import base from "<abs real config>"; export
  default {...base, out: <abs>}`) and the `../../../../plugins/**` globs still resolve —
  while `out` has to be overridden to an absolute path precisely because it is also
  cwd-anchored.
- **The check cache is input-keyed.** `plugins/framework/plugins/tooling/plugins/checks/core/read-set.ts`
  validates a cached PASS by replaying recorded tree facts plus a `sourceHash` over
  `CHECK_SOURCE_PREFIXES`. Moving the globs from a `readFileSync` into an imported module
  makes them **code, invisible to the `FileSystemView`** — the same hazard the
  `plugin-tree/` prefix was added for. `table-defs-in-schema-glob` and the migrations
  checks are *not* `inputKeyed` today (legacy whole-tree keying, sound), so this is a
  forward landmine, not a live bug.
- **`FileSystemView.glob()` is sync; `FileSystemView.readFile()` is async.** So today's
  sync `readFileSync(drizzle.config.ts)` could never have been routed through the view
  without going async anyway. After this change `schemaGlobFiles`'s entire read surface is
  one `Bun.Glob(...).scanSync()` — a 1:1 match for `view.glob()`, so a future
  `inputKeyed` flip is a one-line swap with the function staying **sync**.

## Approach

**Invert the dependency**: the glob set becomes a zero-import constant in `core/`, and
`drizzle.config.ts` becomes a *consumer* of it. Then add one cheap check that imports the
real config and proves drizzle-kit's evaluated `schema` equals that constant.

This was chosen over the alternative of having `schemaGlobFiles` dynamic-import the config
and read `.schema`. That alternative sounds purer, but it reads the config as a *module*,
which the read-set view cannot observe either — so it loses the same observability while
additionally forcing `schemaGlobFiles` async, pulling `drizzle-kit` onto the hot read path
of two checks, and violating the original design intent recorded in
`research/2026-07-08-global-drizzle-schema-load-failure-loud.md` that the glob helper
import "only `fs`/`path`/`Bun`". The constant + guard gets the same guarantee with none of
that.

Patterns are stored **repo-root-relative** — the anchor both consumers can actually name.
Keeping the `../../../../` form inside `core/internal/` would leave two readers silently
agreeing on an unstated anchor two directories up, which is the same shape being removed.
The hop back to the root becomes a named constant whose correctness the check asserts
rather than eyeballs.

## Implementation

### 1. New leaf constant module

**Create** `plugins/database/plugins/migrations/core/internal/schema-glob-patterns.ts`
(named to not collide at a glance with the neighbouring `schema-glob.ts`):

```ts
/**
 * The ONE declaration of which files drizzle-kit discovers as schema.
 *
 * Two independent consumers read this and MUST agree, or the schema-glob checks
 * inspect a different file set than migration generation does — a silent partial DROP:
 *   1. `../../drizzle.config.ts` → drizzle-kit's `schema:` array (authoritative)
 *   2. `./schema-glob.ts` → `schemaGlobFiles()`, used by `schema-files-loadable`
 *      and `table-defs-in-schema-glob`.
 * The `database-migrations:drizzle-config-schema-globs` check proves they agree.
 *
 * ZERO IMPORTS is load-bearing: drizzle-kit loads drizzle.config.ts via a synchronous
 * `require()`, so this module must never pull in `fs` / `Bun.Glob` / a plugin barrel.
 * String constants only.
 *
 * Patterns are REPO-ROOT-RELATIVE — the anchor both consumers can name. Neither
 * `process.cwd()` nor this file's own location is the anchor.
 */
export const SCHEMA_GLOBS = [
  "plugins/**/server/**/internal/tables.ts",
  "plugins/**/server/**/internal/tables-*.ts",
  "plugins/**/server/**/internal/schema.ts",
  "plugins/**/server/**/internal/schema-*.ts",
] as const;

/** This plugin's repo-relative dir — drizzle-kit's cwd for every sanctioned invocation. */
export const MIGRATIONS_PLUGIN_DIR = "plugins/database/plugins/migrations";

/**
 * Hop from `MIGRATIONS_PLUGIN_DIR` back to the repo root. drizzle-kit resolves a
 * relative `schema` glob against its CWD (not against the config file), so
 * drizzle.config.ts must re-anchor each repo-relative pattern with this prefix. The hop
 * count is NOT eyeballed — the guard check asserts it lands exactly on the repo root.
 */
export const REPO_ROOT_FROM_MIGRATIONS_DIR = "../../../..";
```

### 2. `drizzle.config.ts` consumes the constant

Keep the entire existing header comment (the codegen-only / `.invalid` sentinel rationale).
Delete the `NOTE:` paragraph about keeping the array plain string literals — that footgun
is being removed, not re-documented. Replace the `schema:` field:

```ts
import { REPO_ROOT_FROM_MIGRATIONS_DIR, SCHEMA_GLOBS } from "./core/internal/schema-glob-patterns";
// …
  // SCHEMA_GLOBS is the single source of truth, shared verbatim with
  // `core/internal/schema-glob.ts` (the enumerator the schema-glob checks use). The
  // patterns are repo-root-relative; drizzle-kit anchors a relative glob at its CWD,
  // which is this directory — hence the prefix. NEVER inline a literal array here: the
  // `database-migrations:drizzle-config-schema-globs` check proves this equals
  // SCHEMA_GLOBS and fails loudly if it doesn't.
  schema: SCHEMA_GLOBS.map((g) => `${REPO_ROOT_FROM_MIGRATIONS_DIR}/${g}`),
```

The resulting strings are byte-identical to today's four literals — **zero behavioral
delta for drizzle-kit**, the risky consumer.

### 3. Gut `core/internal/schema-glob.ts`

Delete `parseSchemaGlobs`, the `readFileSync`, the `fs`/`path` imports, and the local
`MIGRATIONS_PLUGIN_DIR`. The whole file becomes:

```ts
import { SCHEMA_GLOBS } from "./schema-glob-patterns";

/**
 * Enumerate the schema-glob files drizzle-kit discovers, from the SAME constant
 * drizzle.config.ts builds its `schema:` array out of. Returns sorted repo-relative
 * paths — the form `Bun.Glob` / `git grep` report.
 *
 * This used to read drizzle.config.ts as TEXT and regex the array out, which could
 * silently return a SUBSET (a `schema: [` in prose, a `]` inside a glob character class,
 * a non-literal element) — the checks would then inspect fewer files than drizzle-kit and
 * keep passing. There is no parse any more.
 */
export function schemaGlobFiles(root: string): string[] {
  const files = new Set<string>();
  for (const pattern of SCHEMA_GLOBS) {
    for (const match of new Bun.Glob(pattern).scanSync({ cwd: root })) files.add(match);
  }
  return [...files].sort();
}
```

The `resolve()`→`relative()` round-trip disappears: the patterns are already in the form
`Bun.Glob` wants.

### 4. Barrel

`core/index.ts` line 1 → `export { schemaGlobFiles } from "./internal/schema-glob";`.
Do **not** export `SCHEMA_GLOBS` — it is an internal detail, and exporting it grows the
plugin's public API surface (and its autogen doc block) for no consumer.

### 5. The guard check

**Create** `plugins/database/plugins/migrations/check/drizzle-config-schema-globs.ts`,
id `database-migrations:drizzle-config-schema-globs`, following the shape of its sibling
`drizzle-kit-generate-only.ts` (inlined minimal `Check` type, `cacheSignature: () => null`,
`alwaysRun: true`, a pure exported helper for unit testing). Two assertions:

1. **Structural** — `resolve(root, MIGRATIONS_PLUGIN_DIR, REPO_ROOT_FROM_MIGRATIONS_DIR)`
   must equal `resolve(root)`. A wrong hop count silently narrows drizzle-kit's discovery
   to a non-empty subset.
2. **Value** — `const config = (await import("../drizzle.config")).default;` then set-diff
   `config.schema.map(g => resolve(<root>/MIGRATIONS_PLUGIN_DIR, g))` against
   `SCHEMA_GLOBS.map(g => resolve(root, g))`, reporting `missing` / `extra` explicitly.
   Reject a non-array `schema` loudly. The dynamic import keeps `drizzle-kit` out of the
   check process at module load.

Register it by appending to the default-export array in `check/index.ts`.

Note this check compares **patterns**, not expanded file sets — only running drizzle-kit
can prove the expansion, which `migrations-in-sync` already does.

### 6. Deduplicate `MIGRATIONS_PLUGIN_DIR`

`check/internal/schema-files-loadable.ts` carries its own copy — import it from
`../../core/internal/schema-glob-patterns` instead. (Intra-plugin relative import; legal.)
`migrations-in-sync/check/index.ts` and `cli/bin/migrations.ts` carry two more copies;
consolidating those needs a barrel export — **leave them, note as follow-up.**

### 7. Close the read-set landmine

**Edit** `plugins/framework/plugins/tooling/plugins/checks/core/read-set.ts` —
append to `CHECK_SOURCE_PREFIXES`, with a paragraph in the existing comment block
mirroring the `plugin-tree/` rationale:

```ts
  "plugins/database/plugins/migrations/core/",
  "plugins/database/plugins/migrations/drizzle.config.ts",
```

Scoped to `core/` and the config file specifically, **not** the whole migrations plugin:
that would swallow `data/*.sql`, flipping `sourceHash` on every migration commit and
over-invalidating every input-keyed check (`type-check` included) for a reason unrelated
to their verdicts. Also update the `computeCheckSourceHash` doc-comment to point at
`CHECK_SOURCE_PREFIXES` rather than growing a second list that will rot.

Doing this now rather than deferring: leaving it re-creates exactly the anti-pattern this
task deletes — an armed landmine whose only warning is a comment nobody reads at flip time.
A superset is sound; it can only over-invalidate.

### 8. Tests

- `.../table-defs-in-schema-glob/check/table-defs-in-schema-glob.test.ts`: delete the
  `parseSchemaGlobs` import, the `DRIZZLE_CONFIG_SCHEMA` fixture, and both parser tests;
  fix the header docstring. Do **not** port them — asserting a const array equals itself
  is a tautology.
- Add `check/drizzle-config-schema-globs.test.ts` covering the pure set-diff helper
  (identical → empty; dropped pattern → `missing`; added pattern → `extra`).

### 9. Docs

- `plugins/database/plugins/migrations/CLAUDE.md` — hand-write a short "Which files are
  schema files" section after the existing sync-loadability section. Its autogen block
  loses `parseSchemaGlobs`; regenerated by build, don't hand-edit.
- `.../table-defs-in-schema-glob/CLAUDE.md` — its "read from `drizzle.config.ts` (single
  source of truth, no duplication)" line becomes *true* rather than aspirational; reword to
  name `SCHEMA_GLOBS`.
- `docs/plugins-details.md` — autogenerated by `./equin build`, enforced by
  `plugins-doc-in-sync`.
- Fix two stale references to a long-gone `server/drizzle.config.ts`:
  `plugins/tasks/plugins/tasks-core/server/internal/schema-attachments.ts:8` and
  `plugins/infra/plugins/entity-extensions/CLAUDE.md`.

## Verification

```bash
# Baseline BEFORE editing — the file list must be identical after.
bun -e 'import {schemaGlobFiles} from "./plugins/database/plugins/migrations/core"; \
        console.log(schemaGlobFiles(process.cwd()).join("\n"))' > /tmp/globs-before.txt

bun test plugins/database/plugins/migrations/check/drizzle-config-schema-globs.test.ts
bun test plugins/framework/plugins/tooling/plugins/checks/plugins/table-defs-in-schema-glob/check
bun test plugins/framework/plugins/tooling/plugins/checks/core   # read-set roundtrip

./equin check --list | grep drizzle-config-schema-globs
./equin check database-migrations:drizzle-config-schema-globs schema-files-loadable \
                    table-defs-in-schema-glob database-migrations:drizzle-kit-generate-only
./equin check migrations-in-sync    # load-bearing: actually runs drizzle-kit generate
./equin check type-check plugin-boundaries plugin-refs-resolve
./equin build && ./equin check
```

`migrations-in-sync` is the end-to-end proof: it exercises the temp-config
`import base from "<real config>"` path from a deeper directory, so green there
empirically confirms the config's new relative import survives drizzle-kit's `require()`
loader and that discovery is unchanged.

### Deliberate-divergence experiments (revert each)

- **E1 — the guard catches a re-inlined subset.** Replace `schema:` with a hand-written
  literal array of only the first three patterns → the new check must FAIL naming the
  missing `schema-*.ts` glob. Contrast on the pre-change tree: writing
  `// e.g. schema: ["x"]` as a comment *above* the real array makes the old regex return
  `["x"]` while both consuming checks keep passing — the fail-open behaviour being removed.
- **E2 — the text-parse hazard is gone.** Add `// e.g. schema: ["foo[a-z].ts"]` as a
  comment (both hijacks at once: `schema:`+`[` in prose, and a `]` inside a character
  class). `table-defs-in-schema-glob` and `schema-files-loadable` must both PASS, because
  nothing reads the config as text any more.
- **E3 — the hop-count guard.** Set `REPO_ROOT_FROM_MIGRATIONS_DIR = "../../.."` → the
  check must FAIL reporting it lands on `<root>/plugins` (three hops up from
  `plugins/database/plugins/migrations`). drizzle-kit would then glob
  `<root>/plugins/plugins/**/...` and discover nothing — the silent-DROP failure in its
  most extreme form.

## Risks

| Risk | How it fails loudly |
|---|---|
| drizzle-kit can't load a config with a relative TS import | Contradicted by history (the config previously imported an aliased `@plugins/...` specifier). If wrong: `drizzle-kit generate` exits non-zero → `migrations-in-sync` fails with stderr, build fails. |
| `schema-glob-patterns.ts` later grows an import, breaking the sync `require()` | Config fails to load → `migrations-in-sync` fails; `cli/bin/migrations.ts` has an explicit `require() async module` detector. Mitigated by the "ZERO IMPORTS is load-bearing" comment. |
| Someone re-inlines a literal `schema:` array | The new guard check fails, naming the exact missing/extra globs. This is Option A's only residual risk and it is fully covered. |
| `Bun.Glob` vs drizzle-kit glob semantics differ | Pre-existing and unchanged (identical pattern strings before and after). Separately: `TreeSnapshot.glob()` uses git-pathspec semantics, so verify equivalence at the time someone flips these checks to `inputKeyed` — not now. |
| Over-invalidation from the new `CHECK_SOURCE_PREFIXES` entries | Sound by construction (superset can only over-invalidate); `core/` and the config change ~never, and `data/` is deliberately excluded. |

## Deliberately out of scope

- **`out: "./data"` has the identical cwd dependency** (which is why `migrations-in-sync`
  must override it). Leaving it keeps this change's drizzle-kit-facing delta at exactly
  zero. Worth a follow-up.
- **Absolute globs via `import.meta.dir`** would kill the cwd dependency outright, but if
  drizzle-kit's `esbuild-register` path ever transpiles the config to CJS, `import.meta`
  is rewritten to `{}` and `resolve(undefined, …)` throws. Unverifiable here
  (`node_modules` is not installed in this worktree). A follow-up experiment can unlock it.
- **`parseImperativeTableNameConsts`** in the `table-defs-in-schema-glob` check is the
  same *class* of hand-rolled array-literal regex (over `IMPERATIVE_PUBLIC_TABLES`), with
  the same `[^\]]*` truncation. It is materially safer — it extracts *identifier names*
  (not values, so importing the module wouldn't help) and a partial parse drops exemptions,
  producing a loud false positive rather than a silent pass. Worth a separate look.

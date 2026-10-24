# One owner for the drizzle CLI argv; a lint rule for ad-hoc ones

**Date:** 2026-08-08
**Status:** proposed

## Context

`database-migrations:drizzle-kit-generate-only`
(`plugins/database/plugins/migrations/check/drizzle-kit-generate-only.ts`) fails the
build when the binary's name appears in a quoted token without the word `generate`
inside the next 8 lines. It cannot tell a command from a mention. On 2026-08-08 it
failed the build on `plugins/framework/plugins/tooling/plugins/guards/core/poll-detect.ts`,
where the name sat in a `Set` of mutating binary names alongside `git`, `rm`, … — a
data table that invokes nothing. The reported "non-`generate` drizzle-kit invocation"
pointed at a line that runs no process. It was worked around by deleting the entry
(independently dead code), so the misfire is still armed for the next caller.

The check's *intent* is right. `drizzle.config.ts` sets `dbCredentials` to a
non-resolving `.invalid` sentinel, so every subcommand that dials a database
(`push` / `migrate` / `studio` / `pull`) fails by design; only `generate` — a pure
snapshot diff — is supported through that config. What is wrong is the *detection*:
a proximity heuristic over raw text can never separate an executed argv from a
string literal, because in both cases the token is a quoted word. The `.sh` dialect
is the same guess, and it currently passes only by luck — `regen-migrations.sh`'s
comment happens to read "re-run drizzle-kit generate", so the heuristic resolves it
to the allowed subcommand.

The fix is to stop scanning for the *shape* of an invocation and instead make a
wrong invocation unspellable, then guard only the one path that can still spell one.

## The invariant, restated

1. The argv that runs the drizzle CLI is built in exactly one module, and its
   subcommand is welded to the binary name in a single literal.
2. Nobody else hands that binary name to a process spawn.

(1) is a type constraint — callers configure flags, never the subcommand. (2) is the
only remaining hole, and it is a *syntactic position* an AST can identify exactly:
a literal reaching a spawn's argv. Naming the binary anywhere else — a command-name
table, an error message, prose — is not an invocation and is invisible to the rule.

## Design

### 1. One argv owner

New internal module `plugins/database/plugins/migrations/core/internal/drizzle-cli.ts`:

```ts
/** The CLI binary name. The ONLY place in the repo it is spelled. */
export const DRIZZLE_KIT_BIN = "drizzle-kit";

export interface DrizzleGenerateOptions {
  /** `--custom` — emit an empty data/backfill migration instead of a schema diff. */
  custom?: boolean;
  /** `--name <slug>`. */
  name?: string | null;
  /** `--config=<path>`, relative to the child's cwd (`MIGRATIONS_PLUGIN_DIR`). */
  configPath?: string | null;
}

export function drizzleGenerateArgv(opts: DrizzleGenerateOptions = {}): string[];
```

It returns the full argv including the `bunx` preamble the two call sites duplicate
today — `[process.execPath, "x", "--bun", DRIZZLE_KIT_BIN, "generate", ...flags]` —
so the load-bearing `--bun` rationale (drizzle-kit's shebang is `#!/usr/bin/env node`;
under Node a transitive `Bun.which()` crashes the child into a silent exit-0 with no
migration) lives once, next to the flag it explains, instead of only in the CLI copy.

The options are typed, not a raw `string[]` passthrough: there is no argument shape a
caller can pass that changes the subcommand. That is the half of the invariant that
becomes a `tsc` error rather than a text scan.

Exported from `core/index.ts` beside `MIGRATIONS_PLUGIN_DIR`, for the same reason that
one is public — both sanctioned invocations live in other plugins.

Call sites (both lose their inline binary name):

- `plugins/framework/plugins/cli/bin/migrations.ts:309` —
  `drizzleGenerateArgv({ custom: customMigration, name: migrationName })`, still handed
  to `runDrizzleKitWithPrompts({ cmd, … })`.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/migrations-in-sync/check/index.ts:56` —
  `drizzleGenerateArgv({ configPath: relative(migrationsPluginDir, tmpConfig) })`.

(`check/internal/schema-files-loadable.ts` is *not* a call site — it spawns its own
require-probe, not the CLI.)

### 2. A lint rule for the one remaining hole

New lint contribution `plugins/database/plugins/migrations/lint/`, barrel name
`drizzle-cli-safety`, rule `no-adhoc-drizzle-cli`. Modelled byte-for-byte on
`plugins/infra/plugins/spawn/lint/no-raw-bun-spawn.ts` (same `ESLintUtils.RuleCreator`
shape, same owner-dir skip, same `RuleTester` test style).

It reports a string literal equal to `DRIZZLE_KIT_BIN` **only when that literal reaches
a spawn's argv**:

- an element of an `ArrayExpression` passed directly as a spawn call's first argument; or
- an element of an array bound to a variable that is later passed to a spawn call
  (resolved through ESLint scope analysis — the `const cmd = […]; spawnCaptured(cmd, …)`
  shape both real sites use today); or
- an argument to `.push(…)` / `.unshift(…)` on such a variable.

Spawn callees: `spawnCaptured`, `spawnExpectOk`, `spawnPassthrough` (the sanctioned
chokepoint, `@plugins/infra/plugins/spawn/core`) plus `Bun.spawn` / `Bun.spawnSync` —
the raw forms `spawn-safety`'s own `ignores` still permits in plugin server trees,
tests, and `migrations-interactive.ts`. That list is complete by construction of the
`no-raw-bun-spawn` rule: nothing else in the repo may start a process. It is retyped
here rather than imported, because a lint rule file cannot use `@plugins/*` specifiers
(jiti cannot resolve them).

The binary name itself *is* imported — relatively, `../core/internal/drizzle-cli`, the
one import form that loads under both jiti and Bun within a plugin (the same form
`build-lint-config.ts` uses for `./lint.generated`). So the literal still exists in
exactly one file, and the rule cannot drift from the owner.

Message: the argv is owned by `drizzleGenerateArgv()`; every sanctioned invocation is
`generate` because `drizzle.config.ts`'s credentials are a non-resolving sentinel; to
generate a migration run `./equin build --migration-name <slug>`; to apply one
use the runner or `./equin apply-migrations`.

Adding `lint/index.ts` regenerates `lint.generated.ts` on the next `./equin build`
(the `plugins-registry-in-sync` check fails on drift) — no registry edit by hand.

### 3. Delete the check

Remove `check/drizzle-kit-generate-only.ts` (including `resolveInvocations`, the
`LINE_WINDOW` proximity window, the two dialect regex families and the `SELF` path
hatch) and its entry in `check/index.ts`. Update the two prose references to it:
`plugins/database/plugins/migrations/drizzle.config.ts` (docblock, lines 27–28) and
the "Where drizzle-kit runs from" section of
`plugins/database/plugins/migrations/CLAUDE.md`, which should now say that the argv —
not just the cwd — is single-sourced, and name `drizzleGenerateArgv` as the owner.

## Accepted gaps

Stated rather than hidden, since each is a place the new rule stays silent:

- **`.sh` scripts are no longer scanned.** ESLint sees TypeScript only. Every
  sanctioned invocation runs from TS through the owner, and no shell script in the
  repo invokes the binary; the dropped dialect was in any case guessing, since the TS
  comment masker does not understand `#`.
- **An argv assembled across function boundaries is not traced.** If someone writes
  their own prompt-driver wrapper *and* spells the binary in a helper the array is
  built in, the rule misses it. The owner module removes the reason to do that, and
  such a caller must still spell a name that exists nowhere else in the repo.
- **`package.json` dependency entries and the `import { defineConfig } from "drizzle-kit"`
  in `drizzle.config.ts`** name the npm *package*, not the CLI, and are correctly out
  of scope (they are not string literals in a spawn argv).

## Files

| File | Change |
|---|---|
| `plugins/database/plugins/migrations/core/internal/drizzle-cli.ts` | new — `DRIZZLE_KIT_BIN` + `drizzleGenerateArgv` |
| `plugins/database/plugins/migrations/core/internal/drizzle-cli.test.ts` | new — argv shape |
| `plugins/database/plugins/migrations/core/index.ts` | export `drizzleGenerateArgv` + its options type |
| `plugins/database/plugins/migrations/lint/index.ts` | new — `drizzle-cli-safety` barrel |
| `plugins/database/plugins/migrations/lint/no-adhoc-drizzle-cli.ts` | new — the rule |
| `plugins/database/plugins/migrations/lint/no-adhoc-drizzle-cli.test.ts` | new — `RuleTester` |
| `plugins/database/plugins/migrations/check/drizzle-kit-generate-only.ts` | delete |
| `plugins/database/plugins/migrations/check/index.ts` | drop the import + registration |
| `plugins/framework/plugins/cli/bin/migrations.ts` | build argv via `drizzleGenerateArgv` |
| `.../checks/plugins/migrations-in-sync/check/index.ts` | build argv via `drizzleGenerateArgv` |
| `plugins/database/plugins/migrations/drizzle.config.ts`, `.../migrations/CLAUDE.md` | update the references to the deleted check |

## Verification

1. `./equin test plugins/database/plugins/migrations` — the argv builder test
   (subcommand is `generate` for every option combination; flags append only) and the
   `RuleTester` cases. The rule's fixtures must include both directions: a spawn argv
   containing the name **reports**, and a `new Set(["drizzle-kit", …])` data table
   **does not** — that second case is the regression this whole change exists for.
2. `./equin build` (background) — regenerates `lint.generated.ts` and the plugin
   docs, then runs the full check pass. Confirms `plugins-registry-in-sync`,
   `plugins-doc-in-sync`, `plugin-boundaries` (the `lint/` → `../core/internal/` relative
   import), `type-check` (which reuses the same lint config, so the new rule is enforced
   in the check as well as the IDE), and that migration generation still works end to
   end through the new argv builder.
3. Negative check, by hand and reverted: add `await spawnCaptured([process.execPath, "x",
   "--bun", "drizzle-kit", "push"])` to any non-test file and confirm `bunx eslint` on it
   reports `drizzle-cli-safety/no-adhoc-drizzle-cli`.
4. Re-add the deleted `poll-detect.ts` Set entry locally and confirm nothing fires —
   then revert (the entry was dead code on its own merits).

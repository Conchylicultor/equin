# Single source of truth for the migrations plugin dir

**Date:** 2026-07-29
**Category:** global (`plugins/database/plugins/migrations` + `framework/tooling` + `framework/cli`)
**Follows:** [`2026-07-29-global-drizzle-schema-glob-single-source.md`](./2026-07-29-global-drizzle-schema-glob-single-source.md)

## Context

The predecessor task made `SCHEMA_GLOBS` the one declaration of which files drizzle-kit
discovers, and added a check proving `drizzle.config.ts` agrees with it. It left one
loose end, deliberately: the literal `"plugins/database/plugins/migrations"` is still
hand-written in three places that must agree.

| site | role |
|---|---|
| `migrations/core/internal/schema-glob-patterns.ts:26` (`MIGRATIONS_PLUGIN_DIR`) | the declaration |
| `checks/plugins/migrations-in-sync/check/index.ts:29` | drizzle-kit's `cwd` |
| `cli/bin/migrations.ts:256` | drizzle-kit's `cwd` |

The two consumers use it as drizzle-kit's **cwd**, which is the anchor every relative path
in `drizzle.config.ts` resolves against — `schema:` re-anchors each repo-relative glob with
`REPO_ROOT_FROM_MIGRATIONS_DIR`, and `out: "./data"` is cwd-relative too. A divergence
points migration generation at the wrong directory, where the globs expand to **nothing**
and drizzle-kit reports success having discovered no tables. That is the same silent
partial-DROP failure the predecessor task existed to delete, one level up: the glob set is
now proven consistent, but the anchor it is resolved against is not.

The reason those two were left is a genuine open question, not an oversight:
`MIGRATIONS_PLUGIN_DIR` is currently internal, and reaching it cross-plugin needs a
decision about whether it belongs on the `migrations/core` public barrel.

**Outcome:** yes, it belongs there. One declaration, re-exported through the barrel,
imported by both cross-plugin consumers, with re-inlining blocked by a check.

## The decision: export it from `migrations/core`

Three homes were considered.

**Chosen — re-export from `migrations/core/index.ts`.** The declaration *stays* in
`core/internal/schema-glob-patterns.ts`; the barrel adds one re-export line. There is
direct precedent: `WEB_CORE_RELATIVE = "plugins/framework/plugins/web-core"` is exported
from `@plugins/infra/plugins/paths/server` for exactly this purpose, and is imported by
`cli/bin/commands/build.ts`, `build-composition.ts`, and
`tooling/web-artifacts/check/index.ts` rather than being retyped. This is the established
shape for "a repo-relative plugin dir that other plugins' `bin/` and `check/` code needs."

The predecessor doc's reason for *not* exporting (`grows the public API surface for no
consumer`) was written about `SCHEMA_GLOBS`, which genuinely has no cross-plugin consumer.
It does not transfer: `MIGRATIONS_PLUGIN_DIR` has two, today. `core/` is by definition the
plugin's public API, and api-design's *"logic belongs with the data it operates on"* puts
the migrations plugin's own location on the migrations plugin. Cost is one line in an
autogen doc block.

**Rejected — move it to `infra/paths`** beside `WEB_CORE_RELATIVE`. `drizzle.config.ts`
imports the declaring module under drizzle-kit's synchronous `require()`, and
`schema-glob-patterns.ts` carries a load-bearing *"ZERO IMPORTS"* contract for that reason.
`infra/paths` touches `homedir()` and env at module eval. This would risk breaking
migration generation — precisely the failure class being removed.

**Rejected — export `migrationsPluginDir(root)` instead of the string.** Both cwd
consumers do `resolve(root, DIR)`, so a helper would fit them; but the sibling `data/`
literal is also used as a **bare git pathspec**, which must stay repo-relative. Exporting
the repo-relative string serves every site with one shape, and `resolve(root, …)` at the
call site is the existing repo idiom.

Two safety facts confirmed for the new imports:

- `migrations/core` is a pure, zero-cross-plugin-import leaf (`schema-glob.ts`,
  `destructive.ts`, `schema-glob-patterns.ts`) with no module-eval side effects — unlike
  `@plugins/database/server`/`admin`, which throw at import when `SINGULARITY_WORKTREE` is
  unset (the reason `fork-schema-drift.ts` routes through `@plugins/database/core`).
- `cli/bin/migrations.ts` is imported by **both** `build.ts` and `build-composition.ts`, so
  adding the import to it keeps `cli:build-composition-import-subset` green. `migrations/core`
  is also already in `CHECK_SOURCE_PREFIXES` (`checks/core/read-set.ts:224`), so the new
  import from a check stays cache-sound with no read-set change.

## Implementation

### Step 1 — barrel export (the scoped fix)

**`plugins/database/plugins/migrations/core/index.ts`** — add one line. Export **only**
`MIGRATIONS_PLUGIN_DIR`; `SCHEMA_GLOBS` and `REPO_ROOT_FROM_MIGRATIONS_DIR` stay internal
(no cross-plugin consumer, and the predecessor doc's reasoning holds for them).

```ts
export { schemaGlobFiles } from "./internal/schema-glob";
/** Repo-relative dev-tree location of this plugin — drizzle-kit's cwd for every
 *  sanctioned invocation. NOT the runtime migrations dir (see runner.ts). */
export { MIGRATIONS_PLUGIN_DIR } from "./internal/schema-glob-patterns";
```

**`checks/plugins/migrations-in-sync/check/index.ts:29`** and
**`cli/bin/migrations.ts:256`** — replace the literal with the import:

```ts
import { MIGRATIONS_PLUGIN_DIR } from "@plugins/database/plugins/migrations/core";
// …
const migrationsPluginDir = resolve(root, MIGRATIONS_PLUGIN_DIR);
```

Extend the existing docblock on `MIGRATIONS_PLUGIN_DIR` to name its two cross-plugin
consumers and state the anchor invariant (a wrong cwd silently expands the globs to
nothing). Leave `check/internal/schema-files-loadable.ts` on its intra-plugin relative
import — legal, and it already imports `schemaGlobFiles` from the barrel; switching it to
the barrel for uniformity is optional.

### Step 2 — the guard check — NOT IMPLEMENTED (dropped by the user)

**Status: proposed, declined.** Steps 1 and 3 landed; this did not. Recorded here as the
known residual gap: nothing mechanically stops a fourth hand-written copy appearing, so the
deduplication can decay silently over time. The design below is kept for whoever revisits it.

**Create** `plugins/database/plugins/migrations/check/no-inlined-migrations-dir.ts`, id
`database-migrations:no-inlined-migrations-dir`, mirroring
`paths:no-inlined-worktree-artifacts` (`plugins/infra/plugins/paths/check/index.ts:114-152`)
byte-for-byte in shape: one `grepCode({ pattern, grepArg, fixed: true, maskStrings: false })`
call, an allowlist of path prefixes, `research/` skipped. Register it in the default-export
array in `check/index.ts`.

`maskStrings: false` is load-bearing and is the sanctioned token-in-string case (the path
*is* a string literal); comments are masked regardless, which exempts the prose mentions in
`drizzle-kit-generate-only.ts` and `derived-views/core/internal/imperative-tables.ts`.
Allowlist the declaring module plus the two files that legitimately carry the literal in
non-comment code: `drizzle-kit-generate-only.ts` (its `SELF` self-reference and hint string)
and `imperative-create-table-allowlisted.ts` (its self-reference allowlist). Expect a short
tuning pass here — run the check and allowlist what it reports before widening.

### Step 3 — docs

- `plugins/database/plugins/migrations/CLAUDE.md` — the "Which files are schema files"
  section currently ends by naming the two remaining copies as a follow-up. Rewrite that
  paragraph: `MIGRATIONS_PLUGIN_DIR` is now the barrel-exported single declaration, the
  follow-up is closed, and re-inlining is blocked by the new check.
- `docs/plugins-details.md` / the autogen block — regenerated by `./equin build`,
  enforced by `plugins-doc-in-sync`. Never hand-edit.

## Finding: the sibling `data/` literal has the same silent-failure class

Out of the requested scope, but surfaced because I checked before assuming: the derived
literal `"plugins/database/plugins/migrations/data"` is hand-written in **~11 more places**
across 6 plugins. I expected these to be merely-loud (a wrong path → `readdirSync` ENOENT)
and therefore cosmetic. Three of them are not:

- **`migrations/check/index.ts:88`** — `git diff --quiet origin/main -- MIGRATIONS_SUBDIR`.
  A bad pathspec exits **0** with no output; git does not error. The check would take its
  "no pending migrations" fast path forever, permanently skipping
  `dryRunPendingMigrations` — the one check that stops a broken migration crashing main's
  boot. Verified by reading the call site, not inferred.
- **`cli/bin/migrations.ts:562`** and **`migration-hashes-unique/check/index.ts:69`** —
  `git ls-tree … -- <path>` returns empty on a bad pathspec, so every migration silently
  looks "not tracked on main", corrupting the branch-local/immutable distinction that
  `--reset-migration`, the rehash pass, and the hash-collision exemption all key off.

So this is the same defect class, in git-pathspec form, not tidiness. It is **not** in this
task's scope and I am not folding it in unasked — the diff would touch 6 plugins. Two notes
for whoever picks it up:

- The constants must **compose**, not replace 1:1: `snapshot-chain-intact` needs
  `<data>/meta`, and `MIGRATIONS_DATA_DIR` would derive from `MIGRATIONS_PLUGIN_DIR`.
- Any shared constant must be documented as the **repo-relative dev-tree source location**
  and never conflated with the runtime dir. They genuinely differ: the runner resolves
  `SINGULARITY_MIGRATIONS_DIR ?? join(import.meta.dir, "..", "..", "data")`
  (`migrations/server/internal/runner.ts:22`), and a released bundle points that env var at
  `<bundle>/migrations/data` (`infra/launcher/bin/launch.ts:48`). `release.ts:642` is the
  bridge between the two. None of the 11 sites is the runtime consumer.

Recommend filing this as a follow-up task rather than expanding this one.

## Verification

```bash
# The two cwd consumers must behave identically — this is the load-bearing proof.
# migrations-in-sync actually RUNS drizzle-kit generate from the resolved cwd.
./equin check migrations-in-sync
./equin check database-migrations:drizzle-config-schema-globs schema-files-loadable \
                    table-defs-in-schema-glob database-migrations:drizzle-kit-generate-only

# The new guard, and that it is registered at all.
./equin check --list | grep no-inlined-migrations-dir
./equin check database-migrations:no-inlined-migrations-dir

# Import-graph invariants the new cross-plugin imports could break.
./equin check cli:build-composition-import-subset plugin-boundaries \
                    plugin-refs-resolve type-check

./equin build && ./equin check
```

`./equin build` is itself the end-to-end proof for the CLI half: it drives
`generateMigration` through the edited `cwd` line, so a green build with no spurious
migration means discovery is unchanged.

### Deliberate-divergence experiments (revert each)

- **E1 — the guard fires.** Re-inline `"plugins/database/plugins/migrations"` in
  `cli/bin/migrations.ts` → `no-inlined-migrations-dir` must FAIL naming that file:line.
- **E2 — a wrong anchor is caught, and how.** Point `MIGRATIONS_PLUGIN_DIR` at
  `"plugins/database/plugins"` → `drizzle-config-schema-globs` must FAIL on the structural
  hop assertion (`REPO_ROOT_FROM_MIGRATIONS_DIR` no longer lands on the repo root). This is
  the check the predecessor task added; confirming it still covers the constant *after* it
  becomes public is the point. Contrast: before this change the same edit left
  `migrations-in-sync` and `cli/bin/migrations.ts` pointing at the OLD correct dir, so the
  divergence was invisible to them.
- **E3 — the comment hatch holds.** Write `// plugins/database/plugins/migrations` as a
  comment in an unrelated file → the guard must PASS (`grepCode` masks comments), proving
  it does not punish prose that names the path.

## Risks

| Risk | How it fails loudly |
|---|---|
| The new import in `cli/bin/migrations.ts` reaches a plugin barrel at module-eval time, breaking the ESM-freeze / pre-barrel-guard property | `cli:build-composition-import-subset` fails. Mitigated by construction: `migrations.ts` is imported by both `build.ts` and `build-composition.ts`, so the module set grows identically on both sides; and `migrations/core` is a side-effect-free leaf. |
| The guard check false-positives on legitimate mentions | Loud and immediate (a failing check naming the file:line), never silent. Comments are masked; the residual set is small and allowlisted explicitly. Tune during Step 2, not after. |
| Exporting the constant tempts a consumer to treat it as the *runtime* migrations dir | The docblock on the export names it as the repo-relative dev-tree location and points at `SINGULARITY_MIGRATIONS_DIR`. No runtime code path reads it. |
| Growing `migrations/core`'s public API | One string constant, one autogen doc line. Accepted deliberately — it is the point of the change, and `core/` is the sanctioned home for it. |

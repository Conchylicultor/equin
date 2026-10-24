# Cleanup: dead code left after the typescript+eslint check unification

## Context

Commit `ed1c73fa9` unified the separate `typescript` and `eslint` checks into one
`type-check` check (build each tsconfig's TS program once, share it for tsc
diagnostics and type-aware lint). That migration was correct but left two
pre-existing artifacts behind, both still carrying the now-misleading `eslint`
name:

1. **`framework/.../checks/plugins/eslint`** no longer runs ESLint. It is a
   core-only utility plugin exposing three helpers — an import-graph builder, a
   closure fingerprinter, and a global pass-cache — consumed by **exactly one**
   plugin, `type-check`. The only reason it was ever a standalone plugin was to
   share those helpers between the old `eslint` and `typescript` checks. That
   rationale is gone. The name now actively misleads (it sounds like the ESLint
   check it no longer is), and a single-consumer cross-plugin barrel is needless
   indirection.

2. **`copyEslintCacheToWorktree`** in the worktree plugin still seeds
   `.cache/eslint` (ESLint's native `--cache` flat file) into every new
   worktree. ESLint's `--cache` flag was dropped in `043d1315c` and the eslint
   check deleted in `ed1c73fa9`. Nothing writes or reads `.cache/eslint`
   anymore — the function copies a file that no longer exists to a location
   nothing reads.

Intended outcome: the `eslint` checks-utility plugin disappears (folded into its
sole consumer), the dead worktree-seeding function is removed, and no live code
or doc references a removed `eslint` check.

## Decision

**Fold** the `eslint` checks-utility plugin into `type-check` (its only
consumer) as private internal modules, then delete the standalone plugin.
Chosen over a rename because there is a single consumer — keeping it as a
separately-importable primitive would preserve indirection for a reuse that does
not exist (and the codebase already prefers duplicate-when-needed: the
import-graph extractor was itself copied from `plugin-boundaries`, not shared).

## Cleanup #1 — fold `eslint` plugin into `type-check`

Source: `plugins/framework/plugins/tooling/plugins/checks/plugins/eslint/`
Target: `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/`

### Move (3 files, content unchanged except the renames below)

- `eslint/core/import-graph.ts`  → `type-check/check/import-graph.ts`
- `eslint/core/fingerprint.ts`   → `type-check/check/fingerprint.ts`
- `eslint/core/closure-cache.ts` → `type-check/check/closure-cache.ts`

These go in `check/` (not `shared/`) because only the orchestrator
`check/index.ts` imports them; `shared/worker.ts` does not. Their cross-plugin
import in `closure-cache.ts` — `import { SINGULARITY_DIR } from
"@plugins/infra/plugins/paths/core"` — stays as-is (valid from a `check/`
runtime). Internal cross-references between the three files stay relative.

### De-`eslint` the symbols and cache dir (the whole point of the cleanup)

In the moved `closure-cache.ts`:
- `openEslintClosureCache` → `openClosureCache`
- `interface EslintClosureCache` → `interface ClosureCache`
- cache dir string `"eslint-closure-cache"` → `"closure-cache"` (closure-cache.ts:17)
  — `~/.singularity/eslint-closure-cache` → `~/.singularity/closure-cache`.

> Tradeoff: renaming the on-disk dir means existing worktrees cold-start the
> closure pass-cache once (it recomputes and re-fills under the new name).
> Harmless — the cache is self-healing and content-keyed; a one-time miss only
> makes the first `type-check` after this lands re-lint everything.

### Update the consumer

`type-check/check/index.ts` — replace the cross-plugin barrel import
(lines 27–31) with relative imports of the now-local modules:

```ts
import { buildImportGraphs } from "./import-graph";
import { computeClosureFingerprints } from "./fingerprint";
import { openClosureCache } from "./closure-cache";
```

And update the one call site `const cache = openEslintClosureCache();`
(index.ts:156) → `openClosureCache()`.

### Delete the standalone plugin

Remove the whole directory
`plugins/framework/plugins/tooling/plugins/checks/plugins/eslint/`, including:
- `core/index.ts` (the barrel — no longer needed; type-check imports the files directly)
- `core/import-graph.ts`, `core/fingerprint.ts`, `core/closure-cache.ts` (moved above)
- `package.json` (workspace `@singularity/plugin-framework-tooling-checks-eslint`)
- `CLAUDE.md`

No registry edits: the plugin has no `check/` runtime and no `definePlugin`
default export, so it is in no generated registry. The only inbound reference is
the one barrel import handled above. Removing the workspace package is picked up
by `bun install` during `./equin build`.

> Note: the moved files keep their existing `export`s (e.g. `findLintFiles`,
> `isLintable`, `globalConfigFingerprint`). After the fold these become
> module-internal; they're still used between the three files. Leave them — do
> not prune as part of this cleanup.

## Cleanup #2 — remove dead `copyEslintCacheToWorktree`

File: `plugins/infra/plugins/worktree/server/internal/worktree.ts`

- Delete the function `copyEslintCacheToWorktree` (lines 29–41).
- Delete its call site + surrounding `try/catch` in `setupWorktree` (lines 69–72):

  ```ts
  try {
    await copyEslintCacheToWorktree(repoRoot, wtPath);
  // eslint-disable-next-line promise-safety/no-bare-catch
  } catch {}
  ```

  Leave the adjacent `copyTsBuildInfoToWorktree` try/catch (lines 73–76) intact —
  that sibling is still live (`.cache/tsbuildinfo` is written and read by the
  `type-check` worker).

- Check imports after removal: `existsSync` / `mkdir` / `join` are all still used
  by `copyTsBuildInfoToWorktree` and others, so no import lines change. (The
  comment on `copyTsBuildInfoToWorktree` at line 46 says "rewrite them the same
  way the eslint cache copy does" — reword to drop the reference to the removed
  function, e.g. "rewrite the embedded absolute paths to the worktree root".)

## Cleanup #3 — stale doc reference (adjacent, same unification)

Root `CLAUDE.md` "Available built-in checks" list (~line 131) still documents a
removed check:

```
- `eslint` — runs `bunx eslint .` if `eslint.config.ts` exists. Plugin-contributed rules in `plugins/<name>/lint/` are auto-registered.
```

Update this bullet to describe `type-check` (the check that absorbed it), so the
docs no longer point at a check that does not exist. The autogenerated
`docs/plugins-compact.md` / `docs/plugins-details.md` regenerate from the plugin
tree via `./equin build` — do **not** hand-edit those; the build + the
`plugins-doc-in-sync` check keep them current once the `eslint` dir is gone.

## Critical files

- `plugins/framework/plugins/tooling/plugins/checks/plugins/eslint/**` (deleted; 3 files moved)
- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/index.ts` (imports + call site)
- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/{import-graph,fingerprint,closure-cache}.ts` (new homes)
- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/CLAUDE.md` (autogen block refreshes on build; reword the "Shape" prose only if it now points at a moved file)
- `plugins/infra/plugins/worktree/server/internal/worktree.ts` (remove function + call site, reword comment)
- `CLAUDE.md` (stale `eslint` check bullet)

## Verification

1. `./equin build` — regenerates migrations/docs, runs `bun install`
   (drops the removed workspace), rebuilds. Must succeed.
2. `./equin check type-check` — the relocated helpers must still drive the
   unified check. Expect a green run; the first run after the cache-dir rename
   re-lints the full tree (cold `~/.singularity/closure-cache`), a second run is
   warm/fast — confirms the closure cache writes + reads under the new name.
3. `./equin check plugin-boundaries` — the `type-check → eslint`
   cross-plugin edge is gone; relative intra-plugin imports must pass the
   boundary grammar.
4. `./equin check plugins-doc-in-sync` + `plugins-have-claudemd` — green,
   confirming the deleted plugin is fully out of the generated docs and no
   orphan CLAUDE.md requirement remains.
5. `./equin check` (full) — catch-all; nothing else references the old
   `eslint` plugin id, symbol names, workspace package, or `.cache/eslint`.
6. `rg -n "eslint-closure-cache|openEslintClosureCache|EslintClosureCache|copyEslintCacheToWorktree|checks/plugins/eslint" ` — must return zero hits in source after the change.

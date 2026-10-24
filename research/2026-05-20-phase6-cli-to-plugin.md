# Phase 6: `cli/` → `plugins/framework/plugins/cli/`

Implementation plan for the final DAG migration phase that moves `cli/` into the plugin tree. Part of [`2026-05-12-global-plugin-dag-migration.md`](./2026-05-12-global-plugin-dag-migration.md).

## Context

`cli/` is a standalone workspace at repo root — the only remaining top-level directory outside `plugins/` (besides `gateway/`, which stays as a Go binary). It's a pure leaf: nothing imports from it. The CLI is invoked exclusively via `bun cli/src/index.ts` (the `singularity` shell script and self-invocation in `push.ts`).

The CLI has two roles, neither of which is a cross-plugin API:

| Role | Files | Consumers |
|------|-------|-----------|
| **Commands** — build, check, push, regen-docs, regen-migrations, start | `src/commands/*.ts` | Only the `singularity` shell script and self-invocation in `push.ts` |
| **Support** — paths, broadcasts, migrations, profiler, git merge drivers | `src/*.ts`, `src/git/*.ts`, `git-merge-drivers/*.sh`, `broadcasts.json` | Only the commands above |

No `core/` needed — nothing imports from CLI. The entire directory is an executable entry point (`bin/`), matching the convention in `server-core/bin/`, `central-core/bin/`, and `tooling/plugins/guards/bin/`.

## Dependencies

- **Phase 7 (tooling) must be done first.** CLI imports `@plugins/framework/plugins/tooling/plugins/{codegen,checks}/core` from `build.ts`, `check.ts`, and `regen-docs.ts`. Tooling is already at its final location (`plugins/framework/plugins/tooling/`), so these import paths work unchanged.

## Target directory structure

```
plugins/framework/plugins/cli/
  package.json          ← @singularity/plugin-framework-cli
  tsconfig.json         ← relative paths updated for deeper nesting
  broadcasts.json       ← broadcast gate data (currently [])
  bin/                  ← entry point + all command/support code (was src/)
    index.ts            ← Commander entry point
    paths.ts
    migrations.ts
    broadcasts.ts
    profiler.ts
    git/
      main-repo-root.ts
      register-merge-drivers.ts
    commands/
      build.ts
      check.ts
      push.ts
      regen-docs.ts
      regen-migrations.ts
      start.ts
  scripts/              ← git merge driver shell scripts (was git-merge-drivers/)
    regen-docs.sh
    regen-claudemd.sh
    regen-migrations.sh
```

### Why `bin/`

The CLI is a standalone executable, not a library. `bin/` is the standard convention for entry points across the codebase (`server-core/bin/`, `central-core/bin/`, `guards/bin/`). No `src/` — that's not a recognized plugin folder name.

### Why `scripts/`

The merge driver shell scripts are utility scripts invoked by git during rebase. `scripts/` matches the convention in `server-core/scripts/`. No `git-merge-drivers/` — that's a bespoke name.

### Why no `core/`

Nothing imports from the CLI. It has no public API. Adding an empty `core/` would be structure for structure's sake.

---

## File-by-file change manifest

### A. Files that move (unchanged content)

| Source | Destination |
|--------|-------------|
| `cli/src/index.ts` | `plugins/framework/plugins/cli/bin/index.ts` |
| `cli/src/paths.ts` | `plugins/framework/plugins/cli/bin/paths.ts` |
| `cli/src/migrations.ts` | `plugins/framework/plugins/cli/bin/migrations.ts` |
| `cli/src/profiler.ts` | `plugins/framework/plugins/cli/bin/profiler.ts` |
| `cli/src/git/main-repo-root.ts` | `plugins/framework/plugins/cli/bin/git/main-repo-root.ts` |
| `cli/src/commands/build.ts` | `plugins/framework/plugins/cli/bin/commands/build.ts` |
| `cli/src/commands/regen-docs.ts` | `plugins/framework/plugins/cli/bin/commands/regen-docs.ts` |
| `cli/src/commands/regen-migrations.ts` | `plugins/framework/plugins/cli/bin/commands/regen-migrations.ts` |
| `cli/src/commands/start.ts` | `plugins/framework/plugins/cli/bin/commands/start.ts` |
| `cli/git-merge-drivers/regen-docs.sh` | `plugins/framework/plugins/cli/scripts/regen-docs.sh` |
| `cli/git-merge-drivers/regen-claudemd.sh` | `plugins/framework/plugins/cli/scripts/regen-claudemd.sh` |
| `cli/git-merge-drivers/regen-migrations.sh` | `plugins/framework/plugins/cli/scripts/regen-migrations.sh` |
| `cli/broadcasts.json` | `plugins/framework/plugins/cli/broadcasts.json` |

### B. Files that move with content changes

| Source | Destination | Changes |
|--------|-------------|---------|
| `cli/src/broadcasts.ts` | `plugins/framework/plugins/cli/bin/broadcasts.ts` | `git show` path update |
| `cli/src/git/register-merge-drivers.ts` | `plugins/framework/plugins/cli/bin/git/register-merge-drivers.ts` | 3 script path strings (`git-merge-drivers/` → `scripts/`) |
| `cli/src/commands/push.ts` | `plugins/framework/plugins/cli/bin/commands/push.ts` | 3 self-invocation paths (`cli/src/` → `plugins/framework/plugins/cli/bin/`) |
| `cli/package.json` | `plugins/framework/plugins/cli/package.json` | Package name + bin entry path |
| `cli/tsconfig.json` | `plugins/framework/plugins/cli/tsconfig.json` | Relative path depths + include dir rename |

### C. Files modified in place (not moved)

| File | Change |
|------|--------|
| `singularity` (root shell script) | Entry point path (`cli/src/` → `plugins/framework/plugins/cli/bin/`) |
| `package.json` (root) | Remove `"cli"` from workspaces |
| `plugins/framework/plugins/tooling/plugins/boundaries/boundary-config.ts` | Remove cli zone + edge |
| `.gitattributes` | Comment-only (path in comment) |

### D. Files deleted

| Path | Notes |
|------|-------|
| `cli/` (entire directory) | After all files moved out |

---

## Detailed changes

### 1. `singularity` (root shell script) — CRITICAL PATH

```diff
-exec bun cli/src/index.ts "$@"
+exec bun plugins/framework/plugins/cli/bin/index.ts "$@"
```

**This is the single most important change.** If it's wrong, `./equin build` can't run and nothing can be verified. Update and test this first before touching anything else.

### 2. `push.ts` — 3 self-invocation paths

```diff
 // Line 37: runChecksSubprocess
-  const proc = Bun.spawn(["bun", "cli/src/index.ts", "check"], {
+  const proc = Bun.spawn(["bun", "plugins/framework/plugins/cli/bin/index.ts", "check"], {

 // Line 126: postRebaseNormalize — regen-migrations
-    await exec(["bun", "cli/src/index.ts", "regen-migrations"], root);
+    await exec(["bun", "plugins/framework/plugins/cli/bin/index.ts", "regen-migrations"], root);

 // Line 131: postRebaseNormalize — regen-docs
-    await exec(["bun", "cli/src/index.ts", "regen-docs"], root);
+    await exec(["bun", "plugins/framework/plugins/cli/bin/index.ts", "regen-docs"], root);
```

All three use `cwd: root` (repo root), so the relative path from repo root is correct.

### 3. `register-merge-drivers.ts` — 3 script path strings

```diff
 const DRIVERS: Driver[] = [
-  { name: "regen-docs", script: "cli/git-merge-drivers/regen-docs.sh" },
-  { name: "regen-claudemd", script: "cli/git-merge-drivers/regen-claudemd.sh" },
-  { name: "regen-migrations", script: "cli/git-merge-drivers/regen-migrations.sh" },
+  { name: "regen-docs", script: "plugins/framework/plugins/cli/scripts/regen-docs.sh" },
+  { name: "regen-claudemd", script: "plugins/framework/plugins/cli/scripts/regen-claudemd.sh" },
+  { name: "regen-migrations", script: "plugins/framework/plugins/cli/scripts/regen-migrations.sh" },
 ];
```

These paths are passed to `git config --local` as `merge.<name>.driver` values. They're resolved relative to the repo root by git.

**Note:** Existing worktrees that already have the old git config entries will keep using the old paths until they next run `./equin build` (which calls `registerMergeDrivers`). Since `registerMergeDrivers` compares `current === want` and updates on mismatch, the first build after migration self-heals.

### 4. `broadcasts.ts` — git-show path

```diff
 // Line 61
-  const raw = await gitOutput(["show", "origin/main:cli/broadcasts.json"]);
+  const raw = await gitOutput(["show", "origin/main:plugins/framework/plugins/cli/broadcasts.json"]);
```

**Transition window:** Between the migration landing on main and agents rebasing, old worktrees will try `origin/main:cli/broadcasts.json` which won't exist. This is safe — `gitOutput` returns `null` on failure, and `checkBroadcasts` returns early on null. No breakage, just a silent skip.

### 5. `package.json` (CLI)

```diff
-  "name": "@singularity/cli",
+  "name": "@singularity/plugin-framework-cli",
   "private": true,
   "type": "module",
   "bin": {
-    "singularity": "src/index.ts"
+    "singularity": "bin/index.ts"
   },
```

Follows the naming convention from tooling (`@singularity/plugin-framework-tooling`). Nothing imports this package by name — it's invoked via `bun <path>`, not `import`. The `bin` entry updates to match the new directory name.

### 6. `tsconfig.json` (CLI)

```diff
 {
   "compilerOptions": {
     ...
     "paths": {
-      "@plugins/*": ["../plugins/*"]
+      "@plugins/*": ["../../../../plugins/*"]
     }
   },
-  "include": ["src", "../plugins/packages/plugins/*/shared"]
+  "include": ["bin", "../../../../plugins/packages/plugins/*/shared"]
 }
```

Two changes:
- **Relative path depth:** from `plugins/framework/plugins/cli/`, getting back to repo root requires `../../../../`. Then `plugins/*` appends the rest.
- **Include dir:** `"src"` → `"bin"` to match the renamed directory.

### 7. `package.json` (root)

```diff
-  "workspaces": ["plugins/**", "cli"],
+  "workspaces": ["plugins/**"],
```

The `plugins/**` glob already covers `plugins/framework/plugins/cli/`. The explicit `"cli"` entry is only needed while CLI lives at repo root.

### 8. `boundary-config.ts`

```diff
 export default defineBoundaries({
   zones: [
-    zone("cli", { match: "cli" }),
     zone("plugin", { match: "plugins", discover: "plugin-tree" }),
   ],

   ...

   edges: [
     allow("** -> plugin.plugin-meta.plugin-tree"),
     allow("** -> plugin.packages.retry"),

     allow("tooling -> plugin.config_v2"),
     allow("tooling -> plugin.config_v2.store"),
     allow("tooling -> plugin.plugin-meta.barrel-import"),

-    // CLI can import build-time tooling plugins
-    allow("cli -> plugin.framework.tooling.**"),
-
     // Plugins can import other plugins
     allow("plugin.** -> plugin.**"),
   ],
```

The `cli` zone is removed — CLI is now discovered as `plugin.framework.cli` under the `plugin` zone. The explicit `allow("cli -> plugin.framework.tooling.**")` edge becomes redundant because `allow("plugin.** -> plugin.**")` already permits any plugin to import any other plugin.

### 9. `.gitattributes` — comment-only

```diff
-# Auto-generated artifacts: resolved by custom merge drivers in cli/git-merge-drivers/
+# Auto-generated artifacts: resolved by custom merge drivers in plugins/framework/plugins/cli/scripts/
```

Functional merge driver assignments (`merge=regen-docs` etc.) reference driver names, not paths. The actual paths are in git config (set by `registerMergeDrivers`). Only the comment changes.

---

## Internal relative imports — no changes needed

All relative imports within the CLI (`../paths`, `../broadcasts`, `../migrations`, `../../profiler`, etc.) are between files that move together. They reference sibling/parent paths within what was `src/` and becomes `bin/`. The internal directory structure is preserved (`bin/commands/`, `bin/git/`), so every relative import resolves identically.

---

## Migration order

The critical path is the entry point. If the shell script can't find the CLI, nothing works.

### Step 1: Move files + rename directories

Move `cli/` to `plugins/framework/plugins/cli/`, renaming `src/` → `bin/` and `git-merge-drivers/` → `scripts/` in the process. This can't be a single `git mv` — need individual moves to rename the subdirectories:

```bash
mkdir -p plugins/framework/plugins/cli/{bin,scripts}
git mv cli/src/* plugins/framework/plugins/cli/bin/
git mv cli/git-merge-drivers/* plugins/framework/plugins/cli/scripts/
git mv cli/package.json cli/tsconfig.json cli/broadcasts.json plugins/framework/plugins/cli/
```

### Step 2: Update entry point (CRITICAL)

Update `singularity` shell script immediately. Verify `./equin --help` works.

### Step 3: Update all hardcoded paths

In order of blast radius:
1. `push.ts` — 3 self-invocation paths (breaks `./equin push`)
2. `register-merge-drivers.ts` — 3 script paths (breaks merge driver registration on next build)
3. `broadcasts.ts` — 1 git-show path (degrades silently if stale, non-blocking)

### Step 4: Update config files

1. `package.json` (root) — remove `"cli"` from workspaces
2. `package.json` (cli) — rename package + update bin entry
3. `tsconfig.json` (cli) — update relative path depths + include dir
4. `boundary-config.ts` — remove cli zone + edge
5. `.gitattributes` — update comment

### Step 5: Verify

1. `bun install` — workspace resolves at new location
2. `./equin build` — full build succeeds
3. `./equin check` — all checks pass (boundary rules, plugin boundaries, eslint, etc.)
4. Navigate to `http://<worktree>.localhost:9000` — app loads

### Step 6: Confirm cleanup

Verify `cli/` no longer exists at repo root (handled by `git mv`).

---

## Key risks

### Entry point is the critical path

If the `singularity` shell script points to a nonexistent path, every CLI command fails. The shell script must be updated immediately after the move. Verify `./equin --help` works before proceeding.

### Self-invocation in push.ts

`push.ts` spawns `bun cli/src/index.ts` as subprocesses (check, regen-migrations, regen-docs). These use `cwd: root` (repo root), so the relative path from repo root must be correct. If missed, `./equin push` silently fails at the check step.

### Merge driver paths in existing worktrees

Existing worktrees have `git config --local merge.regen-docs.driver "cli/git-merge-drivers/regen-docs.sh %O %A %B %P"` baked into their `.git/config`. The old path won't exist after migration. Self-heals on next `./equin build` (calls `registerMergeDrivers` which detects the mismatch and re-registers). **Risk window:** if an agent runs `git rebase` before their first post-migration build, the merge driver will fail to find the script. The merge itself won't fail (git falls back to default 3-way merge on driver failure), but the `singularity-merge-markers` won't be dropped, so `postRebaseNormalize` won't fire. Worst case: a manual `./equin regen-migrations` or `./equin regen-docs` is needed after the rebase.

### Broadcasts git-show path transition

After migration lands on main, `origin/main:cli/broadcasts.json` no longer exists. Old worktrees (not yet rebased) silently skip broadcasts. Safe — `checkBroadcasts` returns early on null. New worktrees use the new path.

### Deep nesting of tsconfig relative paths

`@plugins/*` maps to `../../../../plugins/*` — four levels up from `plugins/framework/plugins/cli/`. Fragile to count, easy to verify: `tsc --noEmit` from the CLI directory must pass.

---

## Scope check: what does NOT change

- **Import paths in CLI source** — `build.ts`, `check.ts`, `regen-docs.ts` import from `@plugins/framework/plugins/tooling/plugins/{codegen,checks}/core`. These paths are resolved via tsconfig `@plugins/*` alias, which is retargeted (Step 4). The import text itself is unchanged.
- **Internal relative imports** — all `../paths`, `../broadcasts`, `../migrations` etc. are relative within `bin/` and move together. Unchanged.
- **Merge driver shell scripts** — the `.sh` files themselves use `git rev-parse --git-dir` to find the marker directory. No hardcoded paths. Unchanged.
- **Gateway** — doesn't reference CLI at all. The gateway reads worktree spec JSON files; CLI writes them. No coupling.
- **`.claude/settings.json`** — hooks reference `plugins/framework/plugins/tooling/plugins/guards/bin/guard.ts`, not CLI. Unchanged.
- **`eslint.config.ts`** — references tooling, not CLI. Unchanged.
- **CLAUDE.md files** — the root `CLAUDE.md` references `./equin` commands, not `cli/src/...` paths. The `Folder Structure` section shows `cli/` but that's autogenerated documentation that will be updated by `./equin build` (docgen).

---

## Done when

- `./equin build` succeeds — full build, server boots, frontend loads
- `./equin check` passes — all checks including boundary rules
- `./equin push` works (dry-run: commit + rebase + checks + abort before actual push, or test on a disposable branch)
- `cli/` deleted from repo root
- `plugins/framework/plugins/cli/` is the only CLI location — with `bin/` (not `src/`) and `scripts/` (not `git-merge-drivers/`)
- Root `package.json` workspaces is `["plugins/**"]` only
- Boundary config has no standalone `cli` zone

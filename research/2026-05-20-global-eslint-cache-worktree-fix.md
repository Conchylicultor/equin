# ESLint Cache Fix for Worktrees

## Context

ESLint takes ~7 min on cold runs from any worktree. The root cause: the cache path is computed as `{worktreeRoot}/node_modules/.cache/eslint`, but worktrees have no `node_modules/` (bun resolves from the main repo by walking up). So the cache is never written or read. Second+ runs from the *same* worktree are ~1 min when ESLint manages to write its cache to the shared location, but this is fragile.

Two fixes: (1) use a cache path that actually exists, (2) warm-start new worktrees by copying the main repo's cache with rewritten paths.

## Changes

### Fix 1: Stable cache location

**`plugins/framework/plugins/tooling/plugins/checks/plugins/eslint/check/index.ts`** line 92:

```ts
// Before:
const cacheLocation = join(root, "node_modules", ".cache", "eslint");
// After:
const cacheLocation = join(root, ".cache", "eslint");
```

ESLint creates the `.cache/` directory itself on first write. No mkdir needed.

**`.gitignore`** — add:

```
.cache/
```

### Fix 2: Warm-start cache copy on worktree creation

**`plugins/infra/plugins/worktree/server/internal/worktree.ts`**:

Add helper + call it in `setupWorktree` after `git worktree add`:

```ts
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

async function copyEslintCacheToWorktree(repoRoot: string, wtPath: string): Promise<void> {
  const newLocation = join(repoRoot, ".cache", "eslint");
  const legacyLocation = join(repoRoot, "node_modules", ".cache", "eslint");
  const sourcePath = existsSync(newLocation) ? newLocation : legacyLocation;
  if (!existsSync(sourcePath)) return;

  const raw = await Bun.file(sourcePath).text();
  const rewritten = raw.replaceAll(repoRoot, wtPath);

  const destPath = join(wtPath, ".cache", "eslint");
  await mkdir(join(wtPath, ".cache"), { recursive: true });
  await Bun.write(destPath, rewritten);
}
```

Called inside `setupWorktree` wrapped in try/catch (best-effort — failure just means cold first run, same as today).

**Why `replaceAll` is safe:** The cache is JSON where absolute paths appear as object keys and `filePath` values. All start with the repo root prefix. No partial matches possible. Raw string replace handles all ~3500 occurrences without parsing JSON internals.

**Why backwards-compat fallback:** After Fix 1 deploys, the main repo's existing cache is still at `node_modules/.cache/eslint` until ESLint runs once with the new path. The fallback ensures the copy works immediately.

## Files modified

1. `plugins/framework/plugins/tooling/plugins/checks/plugins/eslint/check/index.ts` — cache path
2. `plugins/infra/plugins/worktree/server/internal/worktree.ts` — cache copy on fork
3. `.gitignore` — ignore `.cache/`

## Verification

1. Run `./equin check --eslint` from this worktree — should create `.cache/eslint` in the worktree root
2. Run it again — should be fast (~1 min) from cache hit
3. Create a new conversation (worktree) — verify `.cache/eslint` exists in the new worktree with rewritten paths
4. Run `./equin check --eslint` in the new worktree — should be fast on first run (~1 min)

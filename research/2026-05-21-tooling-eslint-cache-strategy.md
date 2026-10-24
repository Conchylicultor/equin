# Speed Up ESLint: Switch to Content-Based Cache Strategy

## Context

ESLint is the dominant bottleneck in `./equin build`:
- **Cold cache: 6m 19s** — every new worktree's first build
- **Warm cache: ~10s** — subsequent builds (38x faster)

Since every agent task creates a new worktree, agents consistently pay the 6-minute ESLint tax on their first build. The root cause: 5 type-aware rules require booting the full TypeScript compiler via `projectService` across 1,778 files.

Cache seeding infrastructure already exists — `copyEslintCacheToWorktree()` in `setupWorktree()` copies main's `.cache/eslint` to new worktrees with path rewriting. **But the seeded cache is immediately invalidated** because ESLint's default `metadata` strategy validates entries by file mtime, and `git worktree add` creates all files with fresh timestamps.

## Change

Add `--cache-strategy content` to the ESLint invocation so cache entries validate by file content hash instead of mtime. Worktree files are byte-identical to main, so seeded cache entries will hit.

### File: `plugins/framework/plugins/tooling/plugins/checks/plugins/eslint/check/index.ts`

Line 95 — add `"--cache-strategy", "content"` to the args array:

```ts
// Before:
[process.execPath, "x", "eslint", ".", "--quiet", "--cache", "--cache-location", cacheLocation]

// After:
[process.execPath, "x", "eslint", ".", "--quiet", "--cache", "--cache-location", cacheLocation, "--cache-strategy", "content"]
```

That is the entire code change. Nothing else needs modification:
- `copyEslintCacheToWorktree()` — path rewriting works identically for content-strategy caches
- `bustCacheIfStale()` — compares lint rule source mtimes against the cache *file's* disk mtime, independent of the per-entry strategy
- `eslint.config.ts` — not involved
- `setupWorktree()` — already calls cache seeding

### One-time transition

After merging to main, the first build on main rebuilds the cache with content strategy (~6 min, once). All subsequent worktree first-builds drop from ~6min to ~10s.

## Verification

1. Make the one-line change
2. Delete worktree cache: `rm -f .cache/eslint`
3. Seed from main with path rewrite: `sed "s|/Users/epot/__A__/dev/singularity|/Users/epot/__A__/dev/singularity/.claude/worktrees/att-1779225020-zyma|g" /Users/epot/__A__/dev/singularity/.cache/eslint > .cache/eslint`
4. Run: `time bunx eslint . --quiet --cache --cache-location .cache/eslint --cache-strategy content`
   - Note: main's cache is still metadata-format, so ESLint will re-lint this time. The real savings come after main rebuilds with content strategy.
5. Run `./equin build` to confirm the full build works with the new flag

# Tree-hash-keyed check-result cache

## Context

`./equin build` runs the full check suite via `runChecks()`. Moments later, `./equin push` re-runs the *identical* suite — frequently on a working tree that has not changed since the last green build. There is no memoization keyed on tree content, so push always pays full check cost even when the exact same tree was just verified. The auto-build (git-watcher → `buildRunJob` → `./equin build --allow-main` in the **main** worktree, no `--skip-checks`) likewise re-runs the full suite.

**Goal:** memoize check passes keyed on a content hash of the working tree, stored in a shared location so `build`, `push`, and the auto-build all reuse each other's green results on an unchanged tree.

### Key design constraint — per-check, not per-suite, and eslint is special

The premise "build and push run the identical suite" is true for the *set of check ids* but **not for eslint**. Build lints a cached diff-scope (`.cache/eslint-scoped`); push lints the *affected set* (changed + transitive importers) fresh, no cache — intentionally stronger (the `eslint-cache-crossfile-unsound` learning). Build's eslint pass does **not** imply push's. So:

- A *per-suite* "this tree passed everything" cache would (a) be **unsound** (reintroduces the exact bug affected-set linting fixed), and (b) never cross-hit anyway, since eslint's effective surface differs per command.
- The cache must be **per-check**. The ~19 structural checks + `typescript` are pure deterministic functions of working-tree content → they hit cross-command. `eslint` is parameterized by its scope, so its cache key must fold in that scope; cross-command eslint reuse will (correctly) almost never hit, while typescript + structural checks will.

### Two checks are NOT pure functions of the tree (must opt out)

Audited all 22 checks. Two read state *outside* the working tree and must never be cached:

- **`migration-hashes-unique`** — reads `origin/main`/`main` via `git ls-tree` (`.../migration-hashes-unique/check/index.ts:30-39`). The "frozen" basename set depends on git history; it can change while the tree is byte-identical.
- **`conversation-trailer`** — reads `SINGULARITY_CONVERSATION_ID` env + `git log main..HEAD` trailers (`.../conversation-trailer/check/index.ts:21-53`). Depends on env + history, not tree content.

All others (`typescript`, `snapshot-chain-intact`, `data-migration-dml-only`, all `no-*`, `plugin-boundaries`, and the codegen-sync checks `barrel-stubs-in-sync` / `plugins-registry-in-sync` / `plugins-doc-in-sync` / `config-origins-in-sync` / `plugins-have-claudemd`, plus `migrations-in-sync`) are pure tree functions → cacheable.

> **Collection-consumer separation:** the opt-out must be declared *by the check itself* via the generic contribution API — the runner must never name specific check ids. (CLAUDE.md collection-consumer rule.)

## Approach

Add a per-check, tree-hash-keyed pass cache inside `runChecks()`. One integration point covers all three callers (build in-process, push subprocess, auto-build subprocess). Cache **passes only**, fail-open everywhere.

### 1. Extend the `Check` contribution — `plugins/framework/plugins/tooling/core/types.ts`

```ts
export interface Check {
  id: string;
  description: string;
  run(): Promise<CheckResult>;
  /**
   * Cache-signature contribution.
   *   absent  → cacheable, keyed on tree hash alone (default for pure checks).
   *   string  → cacheable; string folded into the key (e.g. eslint scope).
   *   null    → NEVER cache (impure: reads DB/network/env/git history).
   * Must be cheap and side-effect-free.
   */
  cacheSignature?(): string | null;
}
```

Optional → backward-compatible with all existing checks and the `isCheck` guard in `runner.ts` (unchanged). The three checks that need it (`eslint`, `migration-hashes-unique`, `conversation-trailer`) use a *local* `type Check` literal, so extend that local type in those three files with `cacheSignature?(): string | null` (mirrors their existing local-type pattern; no shared-interface import needed).

- `eslint` (`.../checks/plugins/eslint/check/index.ts`): return a sig derived from `SINGULARITY_ESLINT_SCOPE` + `SINGULARITY_ESLINT_NO_CACHE`:
  - unset → `"scope=full"`; empty list → `"scope=empty"`; list → `"scope=list:<fresh|cached>:<sha256(sorted files)>"`. Encoding the `NO_CACHE` flag keeps build's cached-scoped run from aliasing push's fresh affected-set run.
- `migration-hashes-unique`, `conversation-trailer`: `cacheSignature: () => null`.

### 2. Tree hash — new `plugins/framework/plugins/tooling/plugins/checks/core/tree-hash.ts`

`computeTreeHash(root): Promise<string | null>` — content hash of the full working tree without touching the real index:

1. `mkdtempSync(tmpdir(), "sing-treehash-")`; temp index path inside it (never in the repo, so `add -A` can't stage it).
2. Seed from the real index for its stat cache: resolve `git rev-parse --git-path index` (worktree-correct), `copyFileSync` to temp; if absent, fall back to `read-tree HEAD`.
3. With `GIT_INDEX_FILE=<temp>`: `update-index -q --refresh` (best-effort) → `git add -A` → `git write-tree`.
4. Validate `/^[0-9a-f]{40,64}$/`; return it. **Any failure → `null`** (caller runs uncached). Clean up temp dir in `finally`.

Respects `.gitignore` (excludes node_modules/.cache/dist), captures tracked+working content incl. `bun.lock` (so tool versions are in the key). Commit-message amends during push don't change the tree → push-after-build hits. ~0.65s cold over ~4.4k files (validated). Export from `checks/core/index.ts`.

### 3. Cache store — new `plugins/framework/plugins/tooling/plugins/checks/core/cache.ts`

- **Location (global, not per-worktree):** `join(SINGULARITY_DIR, "check-cache")` — import `SINGULARITY_DIR` from `@plugins/infra/plugins/paths/core` (do not hardcode `.singularity`; enforced by `paths:*` check). Global + content-keyed is what lets the **main-worktree auto-build reuse an agent worktree's passes** for the identical (ff-merged) tree.
- **Format — one file per key** (no shared JSON blob → no write contention):
  - key = `${treeHash}:${checkId}:${sha256(sig)}`; filename = `sha256(key).json`.
  - File presence = a recorded **PASS**. Failures are never written.
- **API:** `openCheckCache()` → `{ has(checkId, treeHash, sig): boolean, record(checkId, treeHash, sig): void }`. `has` = sync `existsSync`. `record` = write to `.<rand>.tmp` then `renameSync` (atomic; concurrent identical writes are harmless). All writes best-effort / errors swallowed.
- **Pruning:** opportunistic (once per `runChecks`): mtime age-out (>14 days) + entry cap (~5000 → trim oldest). Best-effort.

> Check code lives *in the tree*, so any check-logic change alters the tree hash and invalidates its entries automatically — no separate code-version key needed. The cache dir is safe to delete anytime; `SINGULARITY_CHECK_NO_CACHE=1` and `--no-cache` are escape hatches.

### 4. Wire into the runner — `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts`

In `runChecks(ids?, options?)`, before the `Promise.all` map:

```ts
const noCache = options?.noCache || process.env.SINGULARITY_CHECK_NO_CACHE === "1";
const treeHash = noCache ? null : await computeTreeHash(root);   // root via git rev-parse --show-toplevel
const cache = treeHash ? openCheckCache() : null;
```

Per check inside the map:
1. `sig = check.cacheSignature ? check.cacheSignature() : ""` (try/catch → treat throw as `null`).
2. `cacheable = cache && treeHash && sig !== null`.
3. If `cacheable && cache.has(id, treeHash, sig)` → short-circuit to `{ ok: true }`, mark `cached`.
4. Else `await check.run()`; if `cacheable && result.ok` → `cache.record(...)`.

Logging: cached passes print `• <id> ... ok (cached)`. `onCheckDone(id, durationMs, wallStart)` **still fires** for every check (cached hits report their ~0ms real duration → Gantt/profile stays correct). Failure path + epilogue unchanged (failures never cached, always full output). Add `noCache?: boolean` to `RunChecksOptions`.

### 5. CLI — `plugins/framework/plugins/cli/bin/commands/check.ts`

Add `.option("--no-cache", "Bypass the check result cache")`; pass `runChecks(ids, { noCache: opts.cache === false })` (Commander maps `--no-cache` → `opts.cache = false`).

**`build.ts` and `push.ts` need no change** — build calls `runChecks` in-process; push spawns `check` as a subprocess; both inherit caching. Push's existing `SINGULARITY_ESLINT_SCOPE`/`_NO_CACHE` env already feeds eslint's `cacheSignature`.

## What gets fixed

- **push after an unchanged build:** `typescript` + ~19 structural checks served from cache (~0ms); `eslint` re-runs (its sig is the fresh affected-set, a different key — correct/sound); `migration-hashes-unique` + `conversation-trailer` re-run (null sig). The dominant fixed cost (tsc + structural sweep) is eliminated.
- **auto-build (main worktree):** after a ff-merge its tree == the pushed branch tree → the same structural/typescript passes are reused cross-worktree. **Yes, the auto-build is fixed too** — this is exactly why the cache is global + content-keyed rather than per-worktree.
- **eslint is intentionally never cross-cached** (build's cached-scoped ≠ push's fresh-affected-set ≠ main's full). This preserves soundness; eslint remains the one check that re-runs. (A follow-up could unify build's eslint surface with push's to make it cross-cache too, at some build-eslint cost — out of scope here.)

## Files

**New:**
- `plugins/framework/plugins/tooling/plugins/checks/core/tree-hash.ts`
- `plugins/framework/plugins/tooling/plugins/checks/core/cache.ts`

**Modified:**
- `plugins/framework/plugins/tooling/core/types.ts` — add `cacheSignature?` to `Check`
- `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts` — cache lookup/record + `noCache` option + root resolution
- `plugins/framework/plugins/tooling/plugins/checks/core/index.ts` — export tree-hash + cache
- `plugins/framework/plugins/tooling/plugins/checks/plugins/eslint/check/index.ts` — `cacheSignature` (scope sig) + extend local `Check` type
- `plugins/framework/plugins/tooling/plugins/checks/plugins/migration-hashes-unique/check/index.ts` — `cacheSignature: () => null` + local type
- `plugins/framework/plugins/tooling/plugins/checks/plugins/conversation-trailer/check/index.ts` — `cacheSignature: () => null` + local type
- `plugins/framework/plugins/cli/bin/commands/check.ts` — `--no-cache` flag

## Risks / edge cases

- **TOCTOU (edit mid-run):** pre-existing property of the suite; cache doesn't worsen it — a recorded pass is keyed to the hash current at compute time; a later edit changes the hash → next run misses.
- **Concurrent writes:** per-entry files + atomic rename; identical-key writers produce identical bytes. No lock.
- **Failures never cached** → always re-run with full output (preserves truncation/epilogue UX).
- **Fail-open:** `computeTreeHash` → null or any cache I/O error → run uncached. Cache can never block or break a check.
- **eslint scoped-vs-fresh aliasing:** closed by encoding `NO_CACHE` into eslint's sig.
- **Disk growth:** bounded by age-out + entry-cap pruning; dir is deletable anytime.

## Verification

1. Clean tree → `./equin build`. Confirm checks pass; entries appear under `~/.singularity/check-cache/`.
2. Without editing → `./equin push`. In the check subprocess log: structural + `typescript` print `... ok (cached)`; `eslint`, `migration-hashes-unique`, `conversation-trailer` re-run.
3. Auto-build: after main advances via the push, confirm the main-worktree build's structural/typescript checks serve from cache (cross-worktree reuse).
4. Edit one tracked `.ts` (add a comment) → `./equin check`: tree hash changes → **every** check re-runs (miss).
5. `./equin check --no-cache` and `SINGULARITY_CHECK_NO_CACHE=1 ./equin check`: no lookups/records; all run fresh.
6. Introduce a real eslint error → build fails, nothing recorded for eslint; fix → passes and records.
7. `./equin check` (full suite) green end-to-end after all edits.

# Speed up the first `./equin build` on a fresh worktree

## Context

The first `./equin build` on a freshly-created git worktree takes ~9 min; subsequent
builds in the same worktree take ~30 s. Builds on `main` are fast. This makes the agent's first
deploy painfully slow on every new worktree.

Investigation (measured on this machine + historical build-profile JSONs) ruled out the obvious
suspects and isolated the real cost to **redundant, non-incremental type-checking** that runs cold
on a fresh worktree:

- `bun install` cold is **2.4 s** (Bun hardlinks from its global cache) — not the cause.
- The eslint check (`eslint . --cache --cache-strategy content`) already only re-lints the branch
  diff **when the copied content-cache is valid** (`setupWorktree()` seeds `.cache/eslint` from main
  with path-rewriting). So diff-scoping eslint is mostly redundant — dropped from this plan.
- **The actual cold cost is type-checking the same files many times over, all non-incremental:**
  - `build.ts` runs `tsc` for the 3 `hasEntrypoint` runtime targets (cli, server-core, central-core).
  - `check:typescript` *separately* runs `tsc --noEmit` on **all 7** `discoverTscTargets()` (cli,
    central-core, server-core, tooling, web-core, web-sdk, tools) — so cli/server-core/central-core
    are type-checked **twice per build**.
  - No tsconfig sets `incremental`/`composite`, so every pass is a full cold type-check.

**Intended outcome:** remove the duplicate type-checks and make the remaining ones incremental
against a `.tsbuildinfo` baseline seeded from `main` — so a fresh worktree's first build only
re-checks its own diff, not the whole tree. Push must keep running the full type-check + full
type-aware lint unchanged.

Scope chosen: **Lever 1 + Lever 2, then measure.** (Vite-cache relocation L4 and eslint diff-scoping
L3 are deferred — revisit only if the profile still shows a hot span after L1+L2.)

## Lever 1 — Eliminate the duplicate runtime `tsc` passes

Today cli/server-core/central-core are type-checked by both `build.ts` and `check:typescript`. The
runtime passes exist so the server stays type-safe even with `--skip-checks`. Make that guarantee a
single, explicit step instead of an always-on duplicate.

Changes:

- **`plugins/framework/plugins/tooling/plugins/checks/plugins/typescript/check/index.ts`** — after
  `discoverTscTargets(root)`, filter by an optional `process.env.SINGULARITY_TSC_TARGETS`
  (comma-separated target names; absent = all 7). This mirrors the existing env-as-scope channel
  pattern and avoids touching the parameterless `Check.run()` / `RunChecksOptions` contract.
- **`plugins/framework/plugins/cli/bin/commands/build.ts`** — delete the
  `for (const target of runtimeTargets)` loop (~lines 738–754) and its `tsc:<target>` spans from the
  common path. Replace with a single tsc step that runs **only when `opts.skipChecks` is true**,
  covering just the 3 `runtimeTargets` (keep the `tsc:<target>` spans in that branch for profiling
  parity). When checks run, `check:typescript` already covers those 3 — no duplication.

Result: the checks-enabled build drops 3 cold full-Program type-checks. Because the runtime pass and
`check:typescript` now run in **mutually exclusive** branches (checks-on vs `--skip-checks`), they
never execute in the same process — which is what makes Lever 2's single-tsbuildinfo-per-target safe.

Correctness: push runs `check` via subprocess (`push.ts`) with no env scoping → `SINGULARITY_TSC_TARGETS`
unset → all 7 targets type-checked. The gate that matters is untouched.

## Lever 2 — TS `--incremental` + seed `.tsbuildinfo` from main

TS 5.8 supports `--incremental` with `noEmit: true` (writes `.tsbuildinfo`, emits no JS). Write the
buildinfo to a stable path **outside `node_modules`** so it survives `bun install`, then seed it from
main into each new worktree exactly like the eslint cache.

Changes:

- **`plugins/framework/plugins/tooling/plugins/checks/core/discover.ts`** — add and barrel-export a
  helper `tsBuildInfoPath(root, targetName)` →
  `join(root, ".cache", "tsbuildinfo", `${name}.tsbuildinfo`)`. (`.cache/` and `*.tsbuildinfo` are
  already gitignored.)
- **`typescript/check/index.ts`** — append `--incremental --tsBuildInfoFile <abs path>` to each tsc
  invocation, using `tsBuildInfoPath(root, target.name)` (absolute, since `cwd` is `target.dir`).
- **`build.ts` `--skip-checks` branch** — same flags / same per-target path. Identical flag set in
  both branches keeps the shared-per-target file corruption-free.
- **`plugins/infra/plugins/worktree/server/internal/worktree.ts`** — add
  `copyTsBuildInfoToWorktree(repoRoot, wtPath)` mirroring `copyEslintCacheToWorktree`: for each
  `repoRoot/.cache/tsbuildinfo/*.tsbuildinfo`, read, `raw.split(repoRoot).join(wtPath)`, write to the
  same relative path under `wtPath`. Call it from `setupWorktree()` alongside the eslint copy, same
  best-effort try/catch.

Pitfalls / why it's safe:

- `.tsbuildinfo` tracks source versions by **content hash** (under `--incremental`), not mtime — a
  fresh checkout with new mtimes does not invalidate it.
- TS validates the buildinfo against compiler version + options hash; any mismatch → silent full
  rebuild (safe degradation, never wrong output). Seeding is best-effort, never fatal.
- Incremental changes only *what work tsc skips*, never *what it concludes* — diagnostics are
  identical to a clean build.
- **Out of scope:** web-core's `tsc -b` is a separate buildinfo domain that needs `composite: true`
  (heavier change). Left non-incremental for now.

## Critical files

- `plugins/framework/plugins/cli/bin/commands/build.ts` — drop duplicate runtime tsc loop; add
  `--skip-checks`-only single tsc step with incremental flags.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/typescript/check/index.ts` — env target
  filter + incremental flags.
- `plugins/framework/plugins/tooling/plugins/checks/core/discover.ts` (+ checks core barrel) —
  `tsBuildInfoPath()` helper.
- `plugins/infra/plugins/worktree/server/internal/worktree.ts` — `copyTsBuildInfoToWorktree()` seeding.

## Verification

Build profiles land at `~/.singularity/worktrees/<name>/build-profile.json`. Spans of interest:
`check:typescript`, `tsc:<target>`, `check:eslint`, `viteBuild`.

1. **Baseline (cold):** in this worktree run `./equin build`, save `build-profile.json`; record
   `totalDurationMs` and the spans above (this worktree has no profile yet — captures a true cold run).
2. **After L1+L2 (cold):** create a *new* fresh worktree (so `setupWorktree` seeds `.cache/tsbuildinfo`),
   build, and confirm:
   - `tsc:*` spans gone from the checks-enabled path; `check:typescript` drops sharply (seeded
     incremental hit).
   - A `--skip-checks` cold build still type-checks the 3 runtime targets (new branch) and is incremental.
3. **Warm rebuild** (same worktree): `check:typescript` near floor (incremental), `check:eslint` near
   floor (content cache).
4. **Push correctness:** `bun plugins/framework/plugins/cli/bin/index.ts check` (env unset) must run all
   7 tsc targets + full-project eslint. Introduce a deliberate type error / floating promise in an
   *unchanged* file and confirm the full gate still catches it.

Diff the two profile JSONs by `spans[].id → durationMs` to quantify the win.

## Outcome (measured)

L1+L2 landed cleanly — `typescript` is ~9–16s and the duplicate `tsc:*` passes are
gone — but the first cold-build profile **inverted the plan's assumption**: `eslint`
was **591.6s of a 595.6s build**. TypeScript was a rounding error next to it.

Root cause: an ESLint content-cache is invalidated **wholesale** when the config hash
drifts, and `eslint.config.ts` on main moves over time, so a fresh worktree's seeded
cache goes fully cold → `eslint .` re-lints all ~2256 files. Measured: warm = 4–6s,
cold full = 591–1078s.

So a **third lever was added** (the eslint diff-scoping originally deferred), now the
actual fix:

- **`eslint/check/index.ts`** — reads `SINGULARITY_ESLINT_SCOPE` (newline-separated
  changed files); when set, lints that list instead of `.`. Defined-but-empty → skip.
  Scoped runs use a **separate `.cache/eslint-scoped`** so they never prune the
  canonical full-repo cache push relies on.
- **`build.ts`** — `computeEslintScope()` lists `.ts/.tsx` files changed vs
  `git merge-base HEAD main` (+ untracked), filtered against the config's ignore globs
  and existence; sets the env var on non-main builds only. Null (undeterminable or
  >400 files) → full lint. Push / `./equin check` never set it → full lint.

Measured result: cold first build **595.6s → 63.5s** (eslint 591.6s → 17.3s); warm
**43.3s**, now bounded by `vite` (39s, the deferred L4). Correctness verified: full
`eslint .` passes (exit 0), all 7 `tsc` targets pass, and a scoped run leaves the full
2254-entry cache untouched.

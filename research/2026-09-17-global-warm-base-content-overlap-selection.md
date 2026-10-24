# Warm-base pool: pick the base by content overlap, keep the ones on main, one lineage

## Context

The 7–10 GB `bun` processes on the box are `type-check` workers, one per TypeScript
program, from concurrent agent builds. Measured over the last week's transcripts
(`~/.singularity/worktrees/*/check-*.log`):

| web-core worker | peak RSS | CPU |
|---|---|---|
| warm, unchanged tree (second run in a worktree) | 2.1 GB | 31 s |
| fresh worktree's FIRST run (every one of 15 sampled) | 6–11 GB | 240–600 s |
| no buildinfo at all (this checkout, controlled) | 7.0 GB | 230 s |
| seeded from the pool's newest sibling base (controlled) | 5.6 GB | 304 s |

75 % of web-core worker runs host-wide are near-cold. A single cold 7-worker fleet
totals 30–51 GB against a 34 GB host admission ceiling that assumes 3.6 GB per worker.

The cause is which `.tsbuildinfo` a fresh worktree is seeded from. The pool
(`checks/core/warm-base.ts`) keeps the **3 newest** entries per target and hands a
fresh worktree the **newest**. Agents publish ~6 entries per 10 min, so the newest
is always a sibling branch that differs from main by 180–360 files — and seeding
from it costs the same as cold (row 4). The base that would match — the one the
last-merged agent published for the tree that became `main` (main's own auto-build
almost never publishes: after a push its tree is byte-identical to that agent's last
checked tree, the input-keyed check-result cache hits, and `check.run()` never runs)
— is evicted within minutes. A fresh worktree is created with
`git worktree add -b <branch> <path> main`, so its tree IS a main commit's tree.

A second, independent poisoner: the build's `--skip-checks` / hermetic (release)
fast path (`cli/plugins/build/cli/internal/app-artifacts.ts` `fastValidationJobs`)
runs raw `tsc --noEmit` and publishes the result into the **same** pool and the
same local `.cache/tsbuildinfo/<target>.tsbuildinfo`. Those buildinfos carry
placeholder signatures (signature = version) and different compiler options from
the worker (`declaration` + `emitDeclarationOnly` + `rootDir`/`outDir`, see
`shared/worker.ts`). A base with placeholder signatures re-checks a hub's whole
importer closure on a body-only edit — the exact 4.4× CPU / 3× RAM regression the
2026-09-10 emit change removed. Content scoring cannot tell such an entry apart
(file `version`s are identical), so it needs its own fix.

Verified mechanics this plan relies on:

- `fileInfos[i].version` is `sha256(fileText)` hex (TypeScript's `createSHA256Hash`);
  `type-check/check/program-key.ts` already hashes every program file's **bytes**
  with sha256 into a memo, right after the pool seed. For repo `.ts/.tsx` (utf-8,
  no BOM, no `sourceMappingURL`) the two agree byte-for-byte: 6,923 / 6,981 repo
  files of a live entry matched the tree it was built from (the 58 are edits since).
  Do not extend scoring to `node_modules` without re-checking the
  `sourceMappingURL` stripping.
- Buildinfo `fileNames` are relative to the buildinfo file's **own directory**. A
  pool entry must be scored as if it already sat at `<root>/.cache/tsbuildinfo/`
  (resolving against the pool dir yields 0 matches, silently).
- `createIncrementalProgram` (TS 6.0.3) is an `EmitAndSemanticDiagnosticsBuilderProgram`,
  so `getDeclarationDiagnostics()` is incremental — not a memory term. Bun `--smol`
  was measured (8.8 GB vs 7.0 GB cold) and is not a lever.

Outcome: a fresh worktree's first type-check lands at the warm floor (≈2 GB, ≈30 s
for web-core) instead of cold, which removes most of the giant processes; the pool
can no longer be seeded with placeholder-signature bases; and the transcript says
which base each run started from.

Out of scope, to be filed as tasks with the numbers above: (a) per-target admission
weights derived from recorded peaks (`host-admission/core PER_UNIT_BYTES` models a
3.6 GB mean; web-core/test mean 6.7 / 7.2 GB cold); (b) the `test` program
re-checking 6,807 of web-core's files under a second 8 GB worker.

## Design

### 1. `checks/core`: shared buildinfo reading and content hashing

Move, don't duplicate — `checks/core` cannot reach into the `type-check` child.

- **New `checks/core/buildinfo.ts`**: `readProgramFileList(buildInfoPath, resolveBase = dirname(buildInfoPath))`
  moved from `program-key.ts` (lines 141–187, same `ProgramFileList` union:
  `files | absent | unreadable`), extended so the `files` arm also carries
  `versions: (string | undefined)[]` parallel to `files`, read from
  `fileInfos[i]` (string shorthand ⇒ that string; object ⇒ `.version`). Unknown
  shapes stay the `unreadable` arm. `program-key.ts` imports it from the
  `checks/core` barrel.
- **New `checks/core/content-hash.ts`**: `hashFileBytes(abs)` (moved from
  `program-key.ts` line ~103, same `"-"` for absent/unreadable) and
  `export type ContentHashMemo = Map<string, string>` +
  `hashFileCached(memo, abs)`. `ProgramKeyContext.contentHash` becomes a
  `ContentHashMemo`; `programKey()`'s inline `hashOf` closure becomes
  `hashFileCached`. `openProgramKeyContext(listing, memo = new Map())` takes the
  memo so the seed step and the program keys share ONE set of hashes.

### 2. `checks/core/warm-base.ts`: selection by content overlap

```ts
export interface WarmBaseOutcome {
  target: string;
  /** One transcript line, every branch: cold / seeded / kept local / replaced local. */
  line: string;
}
export function materializeWarmBase(
  root: string, targetName: string, memo: ContentHashMemo,
): WarmBaseOutcome
```

- Candidates: every pool entry (newest-first, as `listEntries` returns) **plus the
  existing local base** if present.
- `score(candidate)` = number of repo (non-`node_modules`) entries whose `version`
  equals `hashFileCached(memo, abs)`, with paths resolved against
  `dirname(tsBuildInfoPath(root, target))` regardless of where the candidate sits.
  A raw count, not a ratio: it is "files tsc will not re-check", and a small
  fully-matching program must not beat a large 99 % one. `unreadable`/vanished
  (ENOENT) candidates score nothing and are skipped, never thrown.
- Pick the highest score; ties go to the newest (free from the iteration order).
- No local base ⇒ copy the winner (today's cold-start behaviour, now scored).
  Local base present ⇒ copy the winner over it **only if strictly better** than
  the local score. This also covers the just-rebased worktree (the local base is
  `main(old) + own delta`; the pool's `main(new)` entry now wins by count), the
  open refinement the file's own doc lists.
- The `line` names what happened, e.g.
  `type-check: warm base web-core: pool 1789…-3f2a1c matched 6701/6858 files (local 5120, replaced)`
  / `… kept local 6799/6858 (best pool 6701)` / `… cold, pool empty`.
  Same COPY-never-link rule and ENOENT tolerance as today.

Cost: up to ~9 entries × 8 targets JSON parses (~3 MB each) ≈ 1–2 s on the
preparation thread (already 70–130 s), and the file hashes are the ones the
program keys need anyway.

### 3. Retention: protect the entries that are on `main`

- **Label at publish**: filename becomes `<ms>-<pid>-<sha12>.tsbuildinfo`, sha12
  = `git rev-parse HEAD` of the publishing worktree, read **once per finalize**,
  not per target. `headSha` unavailable ⇒ publish unlabelled (legacy shape), and
  the fact is carried in the outcome line, never a bare `console.error`.
- **Prune**: keep the newest `KEEP_PER_TARGET = 3` as today, **plus** up to
  `PROTECT_ON_MAIN = 6` further labelled entries whose sha is an ancestor of
  `main` (`git merge-base --is-ancestor <sha> main`, exit 0 / 1; any other exit
  is a `{ok:false, reason}` and that entry is simply not protectable). Only
  entries beyond the newest 3 are tested (≤ ~9 spawns per target, run with
  `Promise.all`). The 14-day age-out still applies to everything.
  Rationale: a fresh worktree's merge-base is a main commit, and the agent whose
  branch tip became that commit published exactly its base. `main` is only ever
  fast-forwarded, so "is an ancestor of main" is monotonic — if the spawns ever
  show up in the `finalize <n>s` line, memoise `sha → true` host-globally
  (`pass-set.ts` shape); do not add the memo up front.
- **New `checks/core/warm-base-git.ts`**, modelled on `checks/core/tree-hash.ts`'s
  `spawnCaptured` wrapper:

  ```ts
  export type GitFactResult<T> = { ok: true; value: T } | { ok: false; reason: string };
  export interface WarmBaseGitFacts {
    headSha(root: string): Promise<GitFactResult<string>>;
    isAncestorOfMain(root: string, sha: string): Promise<GitFactResult<boolean>>;
  }
  export const realGitFacts: WarmBaseGitFacts;   // spawnCaptured, timeoutMs 30_000
  ```

  ```ts
  export async function publishWarmBase(
    root: string, targetName: string, headSha: string | undefined,
    git: Pick<WarmBaseGitFacts, "isAncestorOfMain"> = realGitFacts,
  ): Promise<{ labelled: boolean; kept: number; protectedOnMain: number }>
  ```

  `checks/core` already imports `@plugins/infra/plugins/spawn/core` (tree-hash.ts),
  so no new cross-plugin edge.

### 4. `type-check` wiring

- `check/prepare.ts`: create the `ContentHashMemo` **before** the seed loop, pass
  it to `materializeWarmBase` and to `openProgramKeyContext` (today `keyCtx` is
  created after the loop, line ~263). `Plan` gains `warmBase: string[]` (the
  outcome lines). `finalize` becomes `async`: one `headSha`, then
  `Promise.all(outcomes.map(o => publishWarmBase(...)))`, and it returns the
  publish summary line(s).
- `check/prepare-worker.ts`: `handle` becomes `async`, `onmessage` awaits it;
  `PrepareReply` `finalized` gains `lines: string[]`. Wire protocol otherwise
  unchanged (`prepare-thread.ts` already treats both calls as async). Git facts
  cannot cross the Worker boundary (structured clone), so the injectable
  `WarmBaseGitFacts` is a plain parameter used only by in-process tests.
- `check/index.ts`: log `plan.warmBase` lines and the finalize lines through
  `ctx.log` next to the existing `skipped N of M` line, so a run's transcript says
  which base it started from. `program-key.ts` loses its private copies (§1).

### 5. One lineage: the fast path runs the same worker

- **New `type-check/core/index.ts`** (a `core` barrel the build plugin may import;
  no import from `type-check` back into `cli/build` exists, so no cycle):
  - `worker-protocol.ts`: the `TypeCheckWorkerJob` / `TypeCheckWorkerResult` types
    (moved out of `shared/worker.ts`, which imports them via a relative path).
  - `spawnTypeCheckWorker({ root, name, tsconfigPath, buildInfoPath, lintFiles, background })`
    — writes the job file, spawns `[process.execPath, WORKER, jobPath]` via
    `spawnCaptured` with the existing `unbounded` reason, parses the JSON result,
    returns `{ result, exitCode, stderr, maxRssBytes, cpuTimeMicros }`. Moved from
    `check/index.ts` (`runWorker`, lines ~110–150), which now calls it.
- `app-artifacts.ts` `fastValidationJobs` (lines 689–737): replace the
  `execBuffered([..., "x", "tsc", "--noEmit", ...])` call with
  `spawnTypeCheckWorker({ lintFiles: [] })` under the same `grant.run`; lines =
  `result.tscErrors.split("\n")`; success = `exitCode === 0 && tscErrors === ""`;
  `materializeWarmBase` with a fresh memo; `publishWarmBase` on success (now a
  legitimate real-signature base), `headSha` read once for the job list. Delete
  the stale "Identical flags to the `typescript` check" comment; replace with why
  the worker is the only sanctioned producer of a buildinfo (the options and the
  signature emit live in one place, `shared/worker.ts`, so the two producers cannot
  drift). Startup cost of the worker's static `buildLintConfig` import is ~1 s per
  target, against minutes of tsc.

### 6. Tests (`checks/core/warm-base.test.ts`, bun:test, pure fs)

Helpers like `program-key.test.ts` (`mkdtempSync`, write files, write synthetic
buildinfos with `fileNames` + `fileInfos`), fakes like `stall-report.test.ts`.
Point `tsBuildInfoPoolDir` at the temp dir the way that suite isolates data dirs
(or take the pool dir as a parameter with the real default).

1. No local, one candidate → seeded; line reports `matched/scored`.
2. No local, empty pool → cold line, no file written.
3. Local present, pool entry strictly better → replaced.
4. Local present, pool entry ties or loses → kept (never overwritten).
5. Torn entry among good ones → skipped, selection still succeeds.
6. Publish labels with the fake sha; beyond the newest 3, `isAncestorOfMain: true`
   protects an entry and `false` lets it go; protection caps at 6.
7. `headSha` `{ok:false}` → unlabelled publish, no throw, still selectable.
8. Legacy unlabelled names are never protected and never error.
9. `readProgramFileList` with an explicit `resolveBase` resolves against it, not
   the file's directory.

### 7. Docs

- `warm-base.ts` header: recency → content overlap; why counts; the resolve-base
  trap; the on-main protection and its monotonicity.
- `type-check/CLAUDE.md`: a "Which base a fresh worktree starts from" section, the
  new transcript lines under "Reading the transcript", and that the fast path is
  the same worker.
- `app-artifacts.ts` comment as in §5.

## Files

- `plugins/framework/plugins/tooling/plugins/checks/core/warm-base.ts` (rewrite selection + prune + publish)
- `plugins/framework/plugins/tooling/plugins/checks/core/warm-base-git.ts`, `buildinfo.ts`, `content-hash.ts`, `warm-base.test.ts` (new), `index.ts` (exports)
- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/program-key.ts`, `prepare.ts`, `prepare-worker.ts`, `prepare-thread.ts`, `index.ts`
- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/core/index.ts`, `core/worker-protocol.ts`, `core/spawn-worker.ts` (new); `shared/worker.ts` (types import)
- `plugins/framework/plugins/cli/plugins/build/cli/internal/app-artifacts.ts` (fast path)
- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/CLAUDE.md`

## Verification

1. `./equin test plugins/framework/plugins/tooling/plugins/checks` — the new
   suite plus `program-key.test.ts` (moved helpers).
2. `./equin build` in this worktree (background). In
   `~/.singularity/worktrees/att-1789642527-m2ou/check-<runId>.log` expect one
   `type-check: warm base <target>: …` line per target and the publish summary.
3. The load-bearing measurement: create a fresh worktree from main (the app does
   this for any new task; or `git worktree add` a throwaway), run
   `./equin check type-check` there, and read its transcript's
   `type-check worker web-core: cpu …s, maxRSS … GB` line. Success is the warm
   floor (≈2–3 GB, ≈30–60 s) instead of 6–11 GB / 240–600 s, and the warm-base line
   naming a sha-labelled entry with matched ≈ scored. Do it once more after a
   sibling has published a divergent base, to see the scored pick beat "newest".
4. Watch `type-check: prepared off-thread in …s (finalize …s)` for a finalize
   jump from the `is-ancestor` spawns; if it appears, add the host-global sha memo.
5. `./equin build --skip-checks` in a worktree: its transcript shows the
   worker lines, and the pool entry it publishes has real signatures
   (`fileInfos` objects with a `signature` field; a `--noEmit` base has none).
6. After a day: `rg -h 'type-check worker web-core' ~/.singularity/worktrees/*/check-*.log`
   — the share of runs above 5 GB should collapse from ~75 % toward the API-change
   rate; the pool dir should hold ≤ 9 entries per target, ≥ 1 sha-labelled and
   on main.

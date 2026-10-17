# Deps upgrade always reaches a verdict: crash = regression, restore what was installed, bisect a regressed batch

Status: **plan**. Follow-up to `research/2026-10-16-global-deps-versions-always-move.md`
(requirement 2, the npm updater). That plan said "let the runner bisect automatically
if this shows up in practice". It showed up on the first run.

## Context

First end-to-end `./singularity deps upgrade npm` (2026-10-16, worktree
`att-1792107609-34qkm0`, receipt `~/.singularity/worktrees/att-1792107609-34qkm0/deps-upgrade-npm.json`):
79 moves were planned (typescript 6→7, vite 6→8, eslint 9→10, vitest 4→5, zod 3→4,
shiki 1→4, drizzle 0.36→0.45, …). The baseline ran. `apply` did both `bun install`s,
then its `./singularity regen-generated` crashed under TypeScript 7
(`ts.ScriptTarget` is undefined, `plugin-meta/token-usage/core/token-groups.ts:65`).

What `runUpgrade` (`plugins/infra/plugins/deps/plugins/updates/cli/internal/runner.ts`) did with it:

1. **A crash in `apply` is rethrown.** The `catch` puts the files back and
   rethrows, so the receipt stays at `verdict: "running"` with `finishedAt: null`,
   and the CLI exits 1 with no verdict. A release whose own tooling crashes is
   the most obvious kind of regression, yet it is the one case that produces no
   verdict at all.
2. **Only `files()` is restored.** `package.json`s and `bun.lock` go back, but
   `node_modules` keeps the candidate packages. The generated artifacts that
   `regen-generated` rewrote are not restored either, because they are not in
   `files()`. The worktree is left running releases nothing has proven.
3. **One bad release blocks all 79.** A regression is not attributed. The
   prompt's narrowing (`--only <name>`, one at a time) costs one full baseline
   plus candidate per name. At this size that means nothing lands.
4. **The baseline had 100 failing tests.** Grouped by file, they are
   deterministic, not load: a targeted re-run of 5 of those dirs failed 21 tests
   in 4 s. 35 come from `network/live/lint/no-endpoint-read.test.ts`, 12 from
   `watcher-safety/no-detached-watch-reaction.test.ts`, and the rest are mostly
   other lint-rule tests. A test that already fails cannot catch a regression,
   and nothing tells the reader how much the verdict could not see.

Goal: `deps upgrade` **always** ends with a written verdict. It **lands every
move that does not regress**, finds the moves that do on its own, and leaves the
worktree installed exactly as its files say.

## Design

### 1. Every run ends with a verdict (no rethrow, no `running` left behind)

- **A failed `apply` is a candidate failure, not an exception.** The runner
  catches it and records the synthetic gate `{ gate: "apply", failures: ["apply: <first line of the error>"] }`.
  The candidate gates are skipped, because there is nothing coherent to gate.
  `apply` is deterministic, so this counts as confirmed without a retry, and the
  run continues to attribution (§3) like any other regression. The full error
  tail goes in the receipt (`errors`) and the log.
- **Anything else that throws** (prepare, plan, the baseline itself, gates that
  leave no record) makes the verdict `aborted`, with `error: string` on the
  receipt. Files are put back, the receipt is written in a `finally`, and the
  CLI exits non-zero. `UpgradeVerdict` gains `aborted` and `partial` (§3). The
  prompt's last paragraph ("cannot reach a clear verdict → flag") maps to `aborted`.

### 2. Restore what was *installed*, not just the files: `Updater.sync`

New **required** member of `Updater` (`updates/core/internal/updater.ts`):

```ts
/** Bring what is installed/derived in `root` back in line with the files as they are NOW. The runner calls it after every restore. */
sync(root: string, log: (line: string) => void): Promise<void>;
```

It is required rather than optional, so a new updater has to say what restoring
means for it (rung 2). Each updater implements it as follows:

- **npm**: `bun install`, then `./singularity regen-generated`. This brings back
  `node_modules` and the generated artifacts formatted through a moved package.
  Factor `bunInstall` + regen out of `apply` into helpers that `apply` and `sync`
  share.
- **mise**: no-op with a comment. Installs sit side by side, the shims read
  `mise.lock`, and that file has been restored.
- **uv**: no-op with a comment. `apply` only runs `uv lock`, and the envs are
  content-addressed by lock identity.

The runner owns `restore(saved)` + `sync` as one function `putBack()`. It runs
on every exit path that is not `upgraded`, and between bisection probes (§3).
If `sync` fails, the verdict becomes `aborted`, with a message that says the
tree's files are back but its install is not (run `bun install`).

### 3. A regressed batch is bisected automatically, and what passes lands

**Units.** A move carries what must move with it. Add `unit?: string` to `Move`
(`updates/core/internal/updater.ts`). npm's `planNpm` already plans by
lockstep component (`npm/core/internal/plan.ts`, `components(...)`), so each
move gets `unit = <component's first member>`. The runner groups moves by
`(updater, unit ?? name)`, and bisection never splits a unit.

**Cheap probes.** Once the full candidate has confirmed regressions `R`, a
probe does not rerun every gate. It runs only `R`, through the existing
`gates.retry(smoke, R)` (`cli/internal/gates.ts`, `retryGates`: only the failing
check ids, only the failing test files, only the failing smokes). A probe is
`putBack` → `apply(accepted ∪ subset)` → `gates.retry(R)`. A probe passes when
`confirmedFailures(R, result)` is empty. When it fails, it is retried once on
its own failures, the same flake rule as today. A probe whose `apply` throws
fails (§1).

**Search: keep the passing part, recurse on the failing part.**

```
bisect(S, accepted):           // S = units under test
  if probe(accepted ∪ S) passes: return accepted ∪ S
  if |S| == 1: culprits += S; return accepted
  (A, B) = split(S)            // first split: patch/minor units vs major units;
                               // then halves, in plan order
  accepted = bisect(A, accepted)
  return bisect(B, accepted)
```

The first split is risk-aware: in-range moves against range-rewriting (major)
moves. In the 79-move run, that puts about 50 low-risk moves together, so they
usually pass in one probe. Cost is about `2·k·log2(n/k)` probes for `k` culprits,
and each probe is roughly install + regen + the targeted gates (minutes, not a
full suite). A **probe budget** (`MAX_PROBES = 40`, a constant in `runner.ts`)
bounds the run. Units still undecided when it runs out are recorded as
`untested`.

**Final proof.** After bisection, `putBack` → `apply(accepted)` → full
`gates.all` + retry against the same baseline. That catches a failure the
targeted probes could not see. If it shows new confirmed regressions, the search
runs again with those as `R` (at most 2 rounds), and then the accepted set is the
landing set. The tree is left at the landing set.

**Verdicts and receipt.**

| verdict | meaning |
|---|---|
| `current` | nothing to move |
| `upgraded` | every planned move landed |
| `partial` | `landed` non-empty, and some `culprits` and/or `untested` |
| `regressed` | nothing landed. Files put back and synced |
| `aborted` | could not run (`error`). Files put back and synced |

The receipt gains `landed: UpdaterMove[]`, `culprits: { moves: UpdaterMove[]; regressions: GateResult[] }[]`,
`untested: UpdaterMove[]`, `probes: { units: string[]; passed: boolean; failures: GateResult[] }[]`,
`error?: string`. `moves` stays as "planned".

**Not attempted.** Undeclared pairwise interactions (A breaks only without B).
Bisection reports both as culprits, and the agent declares a lockstep group in
`dependencyPolicy`, which becomes a unit on the next run.

### 4. Baseline blind spots are named, and the current ones get fixed

- The receipt records `blind: GateResult[]`, which is the baseline's failures.
  The CLI summary prints "N baseline failures: these could not catch a
  regression". The prompt tells the agent to file a task (`add_task`) for a
  non-empty `blind`, never to fix it in the upgrade.
- The 100 failures from the 2026-10-16 run: step 0 of the implementation reruns
  those files in this worktree (now rebased on main). If they still fail here,
  they are a real red on main, separate from deps, and get fixed (or filed, if
  large) before the end-to-end verification. If they pass, they came from that
  branch's state, and that goes in the report.

### 5. Prompt and CLI

- `upgrade-body.ts` `report()`: `regressed` and `aborted` throw (exit 1).
  `partial` prints landed, culprits and untested, and exits 0.
- `DEPS_UPGRADE_PROMPT` (`updates/core/internal/upgrade-prompt.ts`): step 2
  covers `upgraded` **or `partial`**, and a push names only `landed`. Step 3
  starts from the receipt's `culprits` (already attributed, so no manual
  narrowing): fix ours or hold upstream, then rerun. `untested` moves are left
  for the next weekly run, which re-detects them. Add `aborted` to the "raise a
  flag" paragraph. Update `infra/deps/CLAUDE.md`'s `updates` bullet (verdict
  list, `sync`, bisection).

## Files

- `plugins/infra/plugins/deps/plugins/updates/core/internal/updater.ts`: `Move.unit`, `Updater.sync`.
- `plugins/infra/plugins/deps/plugins/updates/cli/internal/runner.ts`: verdicts, `putBack`, apply-as-failure, `bisect`, final proof, receipt fields. The pure search could go in its own `cli/internal/bisect.ts` (driven by an injected `probe`) so it is unit-testable.
- `plugins/infra/plugins/deps/plugins/updates/cli/internal/runner.test.ts`: new cases (below), with fake updater and gates as today.
- `plugins/infra/plugins/deps/plugins/updates/core/internal/upgrade-prompt.ts` (+ its test), `plugins/infra/plugins/deps/cli/internal/upgrade-body.ts`.
- `plugins/infra/plugins/deps/plugins/npm/server/internal/npm-updater.ts`: `sync`, shared install/regen helpers. `npm/core/internal/plan.ts`: `unit` per component (+ `plan.test.ts`).
- `plugins/infra/plugins/deps/plugins/mise/core/internal/mise-updater.ts`, `plugins/infra/plugins/deps/plugins/python/plugins/uv-updater/server/internal/uv-updater.ts`: `sync` no-ops.
- `plugins/infra/plugins/deps/CLAUDE.md`, `updates/CLAUDE.md`.

## Verification

- `./singularity test plugins/infra/plugins/deps`. New runner cases:
  - `apply` throws → `regressed` (single unit) with an `apply` gate, receipt finished, `sync` called.
  - `plan` throws → `aborted`, receipt finished.
  - 8 units with 2 culprits → `partial`, with exactly those culprits, the rest landed, and the probe count at most the bound.
  - The budget runs out → `untested` filled.
  - A lockstep unit is never split.
  - The final proof finds a new failure → a second round.
- `./singularity test plugins/infra/plugins/deps/plugins/npm`: `unit` assigned per component.
- End to end: `./singularity deps upgrade npm` in this worktree (background). Expected: a
  finished receipt, `partial` or `upgraded`, with typescript 7 (the `regen-generated`
  crash) among the `culprits`, most patch/minor moves in `landed`, `node_modules`
  matching `bun.lock` afterwards (`bun install --frozen-lockfile` is a no-op), and
  `git status` showing only the landed manifests, the lock and the regenerated files.
  Then `./singularity build` is green on the landed set.

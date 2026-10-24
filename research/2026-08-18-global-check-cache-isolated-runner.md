# One way to run a check pass

## Context

`./equin build` runs the check suite **in-process** (`cli/bin/commands/build.ts:1329`), in the
same process that already imported every plugin barrel, ran the slot-declaration pass, and warmed the
per-root `buildBarrelFreeTree` / `buildEnrichedTree` / `declareSlotsFromBarrels` memos via
`regenerateManifestCodegen`. `./equin push` does the opposite: it spawns a fresh
`bun … check --scope tree` child (`cli/bin/commands/push.ts:113`) precisely so checks cannot read a
stale in-process module cache.

So the two `checks ✓` are not the same claim. That would be tolerable if the verdicts stayed
separate, but they do not. A passing check writes a durable entry to the **global** cache at
`~/.singularity/check-cache/`, keyed on `(treeHash, checkId, sha256(sig))` and carrying no
provenance — just `{checkId, treeHash, recordedAt}` (`checks/core/cache.ts:81-130`). Push's clean
subprocess looks the tree hash up, finds the pass the build's contaminated process wrote, and returns
✓ without running anything. The isolation push pays for is spent on a lookup answered by the process
it was isolating itself from.

This is how commit `fa7e865e0` shipped a `docs/plugins-details.md` that only a build could reproduce.
Four consecutive commits each recorded a passing `plugins-doc-in-sync` from a build; four pushes hit
that cache; the failure surfaced four commits and several hours downstream on an unrelated branch.
Fixed at the source in `18126884a` — but the channel is still open for the next impure check.

Two more symptoms of the same defect are already in the tree, worked around rather than fixed:

- `progress-log.ts:89-99` derives the worktree name from `REPO_ROOT` because `SINGULARITY_WORKTREE` is
  set to the dummy `"barrel-import-stub"` by the barrel-import stubs "in the SAME process that then
  runs checks in-process".
- `run-context.ts:11-13` justifies its env-based design with "`build` runs checks in-process".

**Intended outcome:** every cache entry is produced by a process that did nothing but run checks, so
push's cache hit is honest and the cache keeps its value (one run total, not two).

## The fix

`runChecks()` gets exactly **one** in-process caller — the `check` command's own action. `build` and
`push` both reach it by spawning that command through one shared helper. Then build's ✓ and push's ✓
are the same claim by construction, and there is no provenance left to record.

## Phase 1 — build spawns its check pass

### 1.1 Expose per-check settle records — `checks/core/progress-log.ts`

The `end` record already carries `checkId`, `durationMs`, `ok`, `cached` and `t` (an ISO stamp written
synchronously at the settle instant). `readCheckProgress()` throws it away — the `end` branch only
increments a counter. Add one field to `CheckRunProgress`, populated in that existing branch:

```ts
/** Every check that SETTLED, in completion order. `at - durationMs` is the start
 *  instant EXACTLY (both derive from the same `end` record, so they cannot disagree). */
completed: Array<{ checkId: string; at: string; durationMs: number; ok: boolean; cached: boolean }>;
```

Do **not** add a second machine-readable channel (a structured stdout line, a per-run summary JSON):
it duplicates a record that already exists and is written at the *end*, so it is lost exactly in the
case the progress log exists for — a killed or hung run.

### 1.2 `alwaysRun` selection by property — `checks/core/runner.ts`

Add `alwaysRun?: boolean` to `RunChecksOptions`, applied right after the existing scope filter
(`runner.ts:182-196`) and reusing that block's exact shape, including its loud early-return when the
caller also named ids that the filter excludes.

**New and required:** if `alwaysRun` is set and the selection comes out empty, fail loudly. This
replaces the `alwaysRunIds.length > 0` guard `fastValidationJobs` holds today
(`app-artifacts.ts:504`) — once the parent no longer computes the list, the child is the only place
that can notice, and an empty selection reaching `Promise.all([])` is a vacuous pass. If the last
`alwaysRun` check is ever deleted, `build --skip-checks` then fails loudly instead of silently
proving less.

### 1.3 New flags and nesting gates — `cli/bin/commands/check.ts`

Move `const inherited = inheritedGrant();` to the top of the action and name the concept:
`const nested = inherited !== undefined;`, with `marker = !nested`.

| flag | meaning |
| --- | --- |
| `--always-run` | run only checks flagged `alwaysRun`. By property, never by id; composes with `--scope` (AND). |
| `--run-id <id>` | adopt the caller's run id, so `check-<id>.log`, the progress records and the console all name the parent op. |

`--run-id` without `nested` → `process.exit(1)`. A top-level check must mint its own id because that id
also names its op-log row and its kill line; reusing a parent's would collide. This is what lets
`opId` stay a fresh `crypto.randomUUID()` on every path that actually writes an op record.

Gate on `nested`, because the parent already did them:

| site | today | after |
| --- | --- | --- |
| `checkBroadcasts("check")` (`:178`) | runs in the child | gate on `!nested` — also fixes an existing push defect (double-printed banner) |
| `reportInterruptedPredecessor(slug)` (`:189`) | runs in the child | gate on `!nested` — genuinely double-prints under push today |
| `publishLane(...)` (`:197`) | runs | leave unconditional; it not-clobbers and `grant.env()` always sets `SINGULARITY_LANE`. Add a one-line comment rather than a competing rule. |
| the `marker` block (`:247-275`) | gated on `inherited === undefined` | already correct — no double op record, no second worktree marker, no competing signal handler |

### 1.4 The shared helper — new `cli/bin/check-subprocess.ts`

Lives in `bin/`, where cross-command helpers live (`profiler.ts`, `lane.ts`, `admission-valve.ts`) —
and **not** in `bin/commands/internal/`, because `app-artifacts.ts` is one of its three callers.

```ts
export interface CheckSubprocessOptions {
  root: string;
  grant: Grant;
  /** Selection BY PROPERTY ONLY, expressed here as flags and RESOLVED in the child.
   *  Deliberately no `ids` field: a list computed in this process would be read out
   *  of the very module cache the child exists to escape. */
  select?: { scope?: CheckScope; alwaysRun?: boolean };
  /** The caller's run id (`--run-id`). Omit it and `spans` comes back empty. */
  runId?: string;
  output: "inherit" | "capture";
}
export interface CheckSubprocessResult {
  ok: boolean; exitCode: number;
  lines: Array<{ text: string; stream: "stdout" | "stderr" }>;
  spans: Array<{ checkId: string; durationMs: number; wallStartMs: number }>;
  maxRssBytes: number | undefined;
}
```

**argv** — push's exact shape: `["bun", "plugins/framework/plugins/cli/bin/index.ts", "check", …flags]`,
`cwd: root`. Never a positional.

**env** — `{ ...process.env, ...grant.env() }`, then **scrub the barrel-stub sentinel**:

```ts
if (env.SINGULARITY_WORKTREE === BARREL_STUB_WORKTREE) delete env.SINGULARITY_WORKTREE;
```

Value-scoped, never unconditional: a UI/auto build inherits a *real* `SINGULARITY_WORKTREE` from the
backend that spawned it (`plugins/build/server/internal/run-build.ts:416-426`); only the `??=`
sentinel from `registerBarrelStubs` (`barrel-import/core/internal/stubs.ts:27`) is a lie. Export
`BARREL_STUB_WORKTREE` from `barrel-import/core` so it is spelled once. `SINGULARITY_BUILD_IN_PROGRESS`
passes through untouched and **must** — that is how `web-artifacts:map-in-sync` learns to skip a dist
the build is about to replace.

**output** — `"inherit"` → `spawnPassthrough` (push keeps today's live streaming).
`"capture"` → `spawnCaptured` with **`mergeStderr: true`**. Build already buffers into `StepResult.lines`
and renders one step block at the end, so a capturing spawn fits — but two separate buffers would split
the `• <id> … FAIL` line (stdout) from its message (`emitDetail`, stderr), which is precisely the pair a
human reads together. Merging keeps true interleaving at the cost of the per-line stream tag; the
untruncated `check-<runId>.log` transcript keeps both.

**clocks** — `wallStartMs` must be in the *parent's* `performance.now()` domain (`profiler.ts:99-105`
subtracts the collector's `t0`), and the child's `performance.now()` has a different origin. Take one
paired reading in this process immediately before the spawn, and use epoch as the interchange:

```ts
const perfAtSpawn = performance.now();
const epochAtSpawn = Date.now();
// after exit, for each `completed` entry of this runId:
const startEpoch = Date.parse(c.at) - c.durationMs;
const wallStartMs = perfAtSpawn + (startEpoch - epochAtSpawn);
```

This never touches `performance.timeOrigin`, which `check.ts:299-306` warns against (it bakes in a
~6 ms process-start capture error, and would do so twice here). The two readings are adjacent
statements in one process, so the offset's error is sub-millisecond against spans measured in seconds.
**Durations come verbatim from the child** — the reconciliation places a span in the lane and can never
resize one.

**Module docblock** — move push's 18-line comment (`push.ts:95-112`) here in substance. It now governs
three callers and is the only written statement of the "by property, never by id" rule. Extend it with
build's two extra facts: build passes no scope (it deploys, so it is the caller that *can* assert
`scope: "deploy"`), and the child must inherit `SINGULARITY_BUILD_IN_PROGRESS` but not the stub worktree.

### 1.5 Adopt it — push first, then build

**Push** (`push.ts`) — delete the local `runChecksSubprocess`; `runRebasedChecks` becomes one call with
`select: { scope: "tree" }, output: "inherit"`. Land this **first**, so the helper is exercised against a
caller whose behaviour must be byte-identical before a second caller depends on it. The only observable
deltas are the two intended ones from 1.3.

**Build** (`build.ts:1326-1356`) — `fullChecksJob` calls the helper with `runId: buildId`,
`output: "capture"`, no scope filter, then replays `spans` through `pushBuildSpan`. Preserve
deliberately: `id: "checks"` (the failure funnel keys on it at `build.ts:1467`), `label: "checks"`, the
`build:checks` phase and `check:<id>` span ids, and `check-<buildId>.log` under `name` (the child derives
the identical path — `basename(root)` on both sides). `runChecks` drops out of build.ts's imports.
`maxRssBytes` is new information the in-process call could not produce.

**`--skip-checks`** (`app-artifacts.ts:490-532`) — the always-run job calls the helper with
`select: { alwaysRun: true }`. Delete the `listAllChecks()` call, the id list and the length guard. That
deleted call was itself a registry read performed in the contaminated process, so this removes a second
instance of the same mistake; rewrite the docblock's NB accordingly (only `discoverTscTargets` still
reads the registry there). This one edit also covers `build-composition.ts:243`, the other
`fastValidationJobs` caller, for free.

Do **not** pass `background` to the helper: `type-check`'s workers already apply the branch rule at
their own spawn site, and demoting the whole check subtree would be a behaviour change smuggled into a
refactor.

## Phase 2 — keep it that way

### 2.1 Lint rule — rung 3

New `plugins/framework/plugins/tooling/plugins/lint/plugins/check-runner-safety/`, following
`sink-safety` exactly (the plugin that owns a seam owns the rule that routes callers to it). Ban the
`runChecks` value import from `@plugins/framework/plugins/tooling/plugins/checks/core` everywhere except
`cli/bin/commands/check.ts` — a **file**, not a directory, since `build.ts` and `internal/app-artifacts.ts`
are its siblings and are exactly the callers to keep out. Type-only imports allowed; `RunChecksOptions`
is not banned. Verified viable: `cli/tsconfig.json` includes `bin`, and the root ESLint ignores list does
not cover `plugins/**/bin/**`.

**No test exemption**, unlike `sink-safety`: a `*.test.ts` driving `runChecks()` runs in a process that
imported whatever the suite imported and writes to the same global cache a later push reads. A test
harness is inside this blast radius, not outside it.

Rejected: a `grepCode`-based check. The token `runChecks` appears in ~8 comments inside `checks/core`
itself; the AST alternative reimplements what ESLint gets from the parser for free; a check only fires
after a build has already recorded; and a new check would enter the very cache this change exists to
make trustworthy.

### 2.2 Runtime guard — rung 4

`checks/core/run-context.ts` already carries the signal, one character short of usable.
`markBuildInProgress()` stamps `"1"`; stamp `String(process.pid)` instead and add:

```ts
/** True only in the build process ITSELF — never in the check pass it spawns. */
export function isBuildProcess(): boolean {
  return process.env[BUILD_IN_PROGRESS_ENV] === String(process.pid);
}
```

`isBuildInProgress()` becomes a non-empty test, so the child still inherits the marker and still skips
the dist-comparing checks — which is correct and load-bearing. Then, as the **first statement of
`runChecks`** (before `openProgressRun`, so a refused call never becomes a phantom open run), throw if
`isBuildProcess()`. Message names the cache, the transferability requirement, `18126884a`, and the
spawn to use instead.

This is not folded into `assertScopeInvariant`: that validates the loaded check *collection* at load
time; this validates the *process* at call time. Different subject, different lifetime.

Rung 1 — delete the export, give the `checks` plugin its own `bin/` entrypoint so even
`./equin check` spawns it — is reachable but blocked on re-expressing the per-check profiler
clock across a process boundary (`check.ts:290-309`). File as a follow-up.

## Phase 3 — state the contract, version the cache

### 3.1 The tree-purity rule

`Check.scope`'s doc says a `"tree"` verdict "is a function of the working-tree content hash". Add the
second half: it must also be **independent of what else ran in the process**, because that is what makes
a recorded PASS *transferable* — the runner writes an entry from one process and a later push reads it
from another. Use `plugins-doc-in-sync` as the worked example: `reorder`'s `contributions` array starts
empty and is filled by the slot-declaration pass, so the check saw the full set inside a build and none
in a standalone check.

Cite `18126884a`'s fix shape, both halves:

- **Move the precondition into the producer.** `buildEnrichedTree` runs the declaration pass itself,
  memoized per root — not left to one caller's pipeline ordering, where it holds for that pipeline and
  nowhere else.
- **Make the early read throw.** `slotDeclarationPasses()` (a count, not `owners.size > 0`, so a pass
  that legitimately declares no slots is not misread as a pass that never ran) is checked by the
  contributions facet. Without the throw the mistake yields a smaller answer indistinguishable from a
  correct one — which is how it shipped.

Also add to `cacheSignature`: a signature keys a verdict, it cannot make one reproducible. If the
verdict depends on anything outside the checkout *and* outside the signature, the correct value is
`null` and the real repair is at the source.

Mirror both in `checks/CLAUDE.md` as a hand-written section above the autogenerated block, ending with
the new invariant: `runChecks()` has exactly one in-process caller; build and push spawn it.

### 3.2 `inputKeyed` — correct six false comments, then state its extra rule

`inputKeyed` is **not dormant**. Nine checks set it today: `type-check`, `plugin-boundaries`,
`active-data`, `no-raw-event-source`, `no-raw-sse`, `no-raw-websocket`, `no-hardcoded-colors`,
`no-hand-built-link-to`, `no-use-resource-cast`. Every "STAGE 0 / dormant / never fires" comment is
wrong about a path that runs on every check pass:

`types.ts:125-128`, `runner.ts:220`, `runner.ts:239`, `runner.ts:287-288`, `scan-context.ts:12-14`,
`read-set.ts:19-23`.

Then state the missing rule, primarily in `types.ts`'s `inputKeyed` JSDoc — the surface an author hits
the instant they type `inputKeyed:` — and secondarily in `checks/CLAUDE.md`:

> The read-set slot is keyed on `(checkId, cacheSignature())` with **no tree hash at all**
> (`cache.ts` `readSetFile`), so a PASS recorded there survives forward into later trees for as long as
> the replay still validates. A wrong answer on the tree-hash slot is confined to the one tree it was
> recorded against; here there is no tree hash to bound it. A check that is not a pure function of the
> checkout must never be moved onto this flag — fix the impurity at its source first.

`format-clean`, `lint-directives-stable` and `test-layout` already document why they stay off it; point
the next adopter at them.

### 3.3 Cache-key format version

Every entry now in the cache was recorded under the old regime. In `cache.ts`, add a version constant
and route **both** slot names through one minting function, so "bump one slot and forget the other"
becomes inexpressible:

```ts
const CACHE_KEY_VERSION = "v2";

/** The ONE place a cache slot name is minted — a half-invalidated cache is worse
 *  than none, because the surviving half is the half nobody thought about. */
function slotName(parts: string[], suffix: string): string {
  return checkCacheDir.file(`${sha256([CACHE_KEY_VERSION, ...parts].join(":"))}${suffix}`);
}
```

Document on the constant how it differs from `ReadSet.sourceHash`: `sourceHash` hashes the check-system
source and lives *inside* the read-set payload, so it invalidates on check-logic change and is verified
on read — but it cannot help the legacy slot at all, because `has()` is a bare `existsSync` that never
opens the file. The only way to retire a legacy entry is to change its **name**. Bump when the *meaning*
of a recorded entry changes while its key would not; never bump for a change in check logic. **Never
revert a bump** — going back to a retired version re-addresses the entries it was raised to abandon; to
undo `v2`, go to `v3`.

Land this in the **same commit** as Phase 1. Bump earlier and the contaminated builds immediately
repopulate `v2`; bump later and there is a window where clean and dirty entries share the `v1`
namespace. Orphaned `v1` entries are not deleted — they become unreachable and age out under the
existing 14-day `prune()` sweep, well inside the 20 000-entry backstop. Cost: one cold pass per tree.

### 3.4 Documentation the change falsifies

`run-context.ts:11-13` ("`build` runs checks in-process" — the env is now the *propagation* mechanism,
a stronger argument for it), `check.ts:199-204` and `:216-224` ("Push runs its checks via this command"
→ build and push both), `bin/lane.ts`'s header table, and the `check` row in `cli/CLAUDE.md`.

## What this does not fix

**A single check run is still order-dependent.** Checks execute concurrently under one `Promise.all`,
sharing one ESM module cache and one process-level `createdSlots` array (`slot-declaration/core/declaration.ts:62`,
appended at barrel module-eval and never reset). `facets:render-complete`
(`plugins/plugin-meta/plugins/facets/check/index.ts:59`) walks `tree.byDir.values()` and calls
`importBarrel` on **every** plugin's web barrel including disabled ones, while `runDeclarationPass`
(`codegen/core/slot-declaration-guard.ts:79`) deliberately **skips** disabled plugins so their slots
never enter the created-set ownerless. `review/plugin-changes` is disabled and declares a slot. Today
this does not fail, only because `assertSlotsDeclared` is called from the regen pipeline
(`regen-pipeline.ts:178`) and never from a check — but the polluted created-set is visible to any check
in the same run that reads it, and which one wins depends on how the promises interleaved. Same class,
still open. Worth a follow-up task, not this change.

Two smaller follow-ups noted in passing: a `HeavyJob` throw skips `rm(stagingPath)`, leaking a staging
dir to the next run's `sweepDistLeftovers` (pre-existing); and `stubs.ts:34`'s second `??=` with a
different value is dead code.

## Risks

1. **Grant over-subscription — bounded, accepted.** The child's `inheritedGrant()` rebuilds a semaphore
   of the full `units` while the parent's keeps serving other companions. On the full path the parent
   holds exactly 1 unit (the whole pipeline runs inside one `grant.run`, `app-artifacts.ts:759`), so the
   overshoot is ≤ 1 unit — versus today, where checks and vite shared one semaphore. No host-wide
   re-acquire happens either way.
2. **Build gets slower** by a fresh CLI bootstrap plus a cold load of every check module: measured at
   ~1.6 s warm / ~10 s cold (`bun … check --list`), against a ~10 min build. Push pays exactly this today.
3. **Spawn failure must not be caught.** `Bun.spawn` throws synchronously on ENOENT; a throwing
   `HeavyJob` propagates out of `Promise.all` exactly as a throwing `runChecks` does today, and build's
   exit backstop renders "aborted before completing". Absorbing it into `ok: false` would report "checks
   failed" for a machine with no `bun`.
4. **Orphan window on a killed build.** `spawnCaptured` exposes no `onSpawn`, so a SIGKILLed build leaves
   the child running until its orphan guard notices ppid 1 (≤ 2 s). Push has the identical window today.
5. **The Gantt lane now depends on the child's `end` records.** A killed child draws a partial lane —
   honest, and strictly better than today, where an interrupted in-process pass drew nothing.

## Verification

1. `SINGULARITY_CHECK_NO_CACHE=1 ./equin check` — full pass, unchanged behaviour.
2. `./equin check --always-run` and `--scope tree --always-run` — correct subsets;
   `./equin check --run-id x` (no parent grant) exits 1 with the loud message;
   `./equin check --always-run type-check` exits 1 as an excluded named id.
3. `./equin build` (background, per CLAUDE.md) — must not throw, must spawn a child; verify
   `~/.singularity/worktrees/<wt>/build-status.json` is `status: ok`, that `check-<buildId>.log` exists
   and is this run's, and that the build Gantt's `build:checks` lane has one bar per check at plausible
   offsets (not stacked at the end).
4. `./equin build --skip-checks` — the always-run subset runs in a child; temporarily flipping the
   last `alwaysRun: true` off makes it fail loudly rather than pass vacuously.
5. `./equin push` on an unchanged tree — after the version bump the first pass is a real run, not
   a hit; a second `./equin check` on the same tree then reports `(cached)`.
6. Confirm the guard bites: temporarily reinstate an in-process `runChecks` in `build.ts` and check that
   both the lint rule and the `isBuildProcess()` throw fire.
7. `./equin check` (full) to confirm the new lint rule and the regenerated docs are in sync.

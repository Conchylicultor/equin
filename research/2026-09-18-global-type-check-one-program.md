# type-check: one program for the whole repo

**Date:** 2026-09-18
**Category:** global (root tsconfigs; framework/tooling checks + cli build; infra/host-admission; packages/semaphore)
**Status:** BUILT 2026-09-19 (`att-1789665118-gl85`) — see "As built" at the foot. Layout and the 2-unit weight approved by the owner in conversation.
**Closes:** follow-ups (a) and (b) of `research/2026-09-17-global-warm-base-content-overlap-selection.md`;
sidequest A.4 on the "Build, check, …" page (`block-f0d24b10-d743-409d-bbc1-844ed27db026`), taken to its end.

## Context

`type-check` spawns one worker per tsconfig target. There are seven: `web-core` (tsconfig.app.json),
`server-core`, `central-core`, `cli`, `tooling`, `tools` (root tsconfig.tools.json) and `test`
(root tsconfig.test.json). Measured from the pooled `.tsbuildinfo` files (TypeScript 6.0.3, this
host, 2026-09-17), the seven programs hold **30,649 file instances for 8,252 distinct repo files
(3.7×)**:

| files in N programs | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| count | 1,148 | 3,137 | 76 | 365 | 49 | 3,045 | 432 |

The two largest overlaps are the ones this task names. `test` holds 8,053 repo files, of which only
1,076 are test-only (702 `*.test.ts`, 209 `e2e/`, 163 `web/__tests__/`, 2 `test/`); 6,868 of them
are also in `web-core`. `server-core` and `central-core` share 3,959 of ~3,970 each; `cli` and
`tooling` are further near-copies. Per worker, over every check transcript on this host (n ≈ 300
per target, `~/.singularity/worktrees/*/check-*.log`):

| target | cpu mean | cpu p50 | peak RSS mean | p50 | max |
| --- | --- | --- | --- | --- | --- |
| test | 180 s | 125 s | 7.2 GB | 7.0 | **16.6** |
| web-core | 209 s | 175 s | 6.7 GB | 6.7 | 14.3 |
| server-core | 104 s | 101 s | 4.3 GB | 4.6 | 7.8 |
| cli | 78 s | 74 s | 3.9 GB | 3.9 | 8.8 |
| central-core | 79 s | 79 s | 3.8 GB | 3.9 | 7.7 |
| tooling | 67 s | 70 s | 3.5 GB | 3.6 | 6.8 |
| tools | 22 s | 21 s | 1.0 GB | 1.0 | 1.9 |

A cold miss runs all seven at once: ~740 CPU-s mean and ~30 GB of simultaneous resident memory,
against a 32 GB admission ceiling that models each worker at 3.6 GB.

### The fact that decides the layout

The split was believed to buy type-environment isolation ("a `window` reference in `core/` fails
under the node program", per the plugin's CLAUDE.md). It does not. Read from the same buildinfos,
**six of the seven programs load the same environment**: `lib.dom.d.ts` (the node-side tsconfigs
set no `lib`, so TypeScript defaults to `es2023.full`, which includes DOM), `@types/node`,
`@types/bun`, and `@types/react` (web-core's tsconfig.app.json sets no `types`, so every
`node_modules/@types/*` at the root is auto-included — and that auto-included set is exactly the
set `tsconfig.test.json` names explicitly). Only `tools` (`lib: ["ES2023"]`) withholds DOM.
Runtime isolation (web must not import server, …) is the `plugin-boundaries` check's job, not
tsc's. So the programs are seven copies of one environment over overlapping file sets, and the
`test` program — 8,053 of the 8,252 files under the union environment — is already a working
prototype of the single program.

Prior research reached the doorstep of this: `2026-09-08` Finding 5 ("1 program: everything under
one tsconfig — 73% fewer file-checks; test already nearly is") and `2026-09-09` Finding 4 (merge the
node side, A.4). The owner's note on the page ("Good to have zones just for architectural reason.
Not for actual isolation.") is the same conclusion from the other side.

### Decision (owner, 2026-09-18)

1. **One TypeScript program for the whole repo**, one worker. The three-program (A.4) and
   two-program (web / node) layouts were considered and rejected: both keep the ~3,900 `core/` +
   `shared/` files checked twice under identical environments, and three keeps `test` as a second
   full copy of the app.
2. **The single worker spends two grant units.** Collapsing seven workers into one changes what a
   unit means (today a build spends up to 7 × 3.6 GB; after, one worker that peaks at 7 GB mean),
   so the admission weight ships with the layout rather than as a later fix.

Expected effect per miss: CPU ÷ ~3.7 (the union program is the `test` program + 2.5% files, so
one worker ≈ today's `test` worker), simultaneous resident memory from ~30 GB to one worker's
~7 GB, cold wall clock unchanged (`test` was already the wall-clock floor of every miss).

**Approval note.** Almost every file below is under `plugins/framework/`, which `plugins/framework/CLAUDE.md`
gates on the user's approval in the conversation. Approval of this plan is that approval.

## Design

### 1. The program: root `tsconfig.json`

`tsconfig.base.json` stays exactly as it is — `paths` are read from it directly by
`cli/plugins/release/cli/run.ts` and `bootstrap/cli/ensure-deps.ts`, and the
`tsconfig-alias-single-owner` check names it. The root `tsconfig.json` stops being a `files: []` +
`references` umbrella and becomes the program:

```jsonc
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    // No `lib`: the default for target ES2023 is es2023.full — DOM, DOM.Iterable,
    // DOM.AsyncIterable and the rest — which is what five of the seven programs
    // already loaded, and a superset of the explicit web/test list.
    "types": ["node", "@types/bun"],
    "allowImportingTsExtensions": true,
    "moduleDetection": "force"
  },
  "include": ["plugins", "test", "*.config.ts"],
  "exclude": ["**/node_modules", "**/dist", "**/dist.*"]
}
```

- `types` is explicit because the auto-included set and the explicit set are measured equal; an
  explicit list keeps a stray `@types/*` install from silently widening the globals.
- `useDefineForClassFields` is dropped: it is the default for target ≥ ES2022.
- `include` is the whole lintable universe by construction: every `.ts`/`.tsx` git tracks outside
  `plugins/` is `test/*.ts`, `vitest.config.ts` or `eslint.config.ts`. Every collected dir
  (`web`, `server`, `check`, `facet`, `composition`, `data-dirs`, `prewarm`, `provision`, `vite`,
  `scripts`, `lint`, `cli`, `bin`, `e2e`, `fixtures`, `__tests__`, `shared/*.d.ts`,
  `web/vite-env.d.ts`, the gitignored `*.composition.*.generated.ts` registries) is under it.
- tsc's include expansion is a filesystem walk, not a git listing, so the excludes name what is on
  disk but not in git: `node_modules` and the `dist*` release trees (`web-core/dist` is a symlink to
  `dist.live.<pid>`, plus `dist.staging.*` / `dist.old.*` / `dist.swap.*`). Dot-prefixed
  directories (`.cache`, `.check-*`, `.claude/worktrees`) are never matched by `*`/`**` in a
  tsconfig pattern, so they need no entry. Verify the expansion once with
  `tsc -p tsconfig.json --listFilesOnly` during implementation.
- Delete: `tsconfig.test.json`, `tsconfig.tools.json`,
  `plugins/framework/plugins/web-core/tsconfig.json` + `tsconfig.app.json`,
  `plugins/framework/plugins/{server-core,central-core,cli,tooling}/tsconfig.json`.
  `plugins/primitives/plugins/passthrough/lint/tsconfig.case.json` is a RuleTester fixture and stays.
- Nothing else reads those files: the web build (`tooling/plugins/web-artifacts/core/internal/vite-builder.ts`)
  aliases `@plugins` itself and uses no tsconfck; bun's runtime path mapping reads the root
  tsconfig, which keeps `extends: ./tsconfig.base.json`; typescript-eslint's `projectService`
  (`eslint.config.ts`) and editors find the nearest tsconfig walking up, which for 99% of files is
  already the root one today.

### 2. `type-check`: one program, no targets

The target concept disappears (rung 1: delete the concept), not "a list of length one".

- `checks/core/discover.ts` — `discoverTscTargets` / `TscTarget` (`dir` + `args` + `hasEntrypoint`)
  become `repoProgram(root): TscProgram` = `{ name: "repo", tsconfigPath: join(root, "tsconfig.json") }`.
  `tsBuildInfoPath(root, name)` is unchanged. `type-check/core/tsconfig-path.ts` (`tsconfigPathOf`,
  the `-p` re-parse) is deleted with the `args` encoding it decoded. Re-export from the
  `checks/core` barrel; `type-check/core/index.ts` drops `tsconfigPathOf`.
- `type-check/check/prepare.ts`
  - `computeOwnership` and the `web-core`-first ordering are deleted: every lintable file is linted
    under the one program.
  - The coverage gate becomes exact and cheaper: `uncovered = lintable − roots` (roots = the
    tsconfig's include expansion from `parseTargetRoots`, now `parseProgramRoots`). No forward-
    closure walk: with a blanket include, a lintable file that is not a root is by definition
    outside `include` (a stray `scripts/x.ts` at the repo root), which is exactly what the gate must
    fail on.
  - `lintByTarget` → `lintFiles: string[]`; one `materializeWarmBase`, one `programKey`, one
    `skipped: boolean` (the clause is unchanged: recorded green AND nothing to lint AND
    `cacheEnabled`), one `unkeyed?: string`. `Plan` and `TargetOutcome` become singular
    (`program: { name, tsconfigPath }`, `run: boolean`, `outcome: ProgramOutcome | undefined`).
    `finalize` publishes one base, records the lint PASSes and the one program PASS or re-record.
- `type-check/check/index.ts` — no `mapConcurrent`; one `runWorker` under
  `ctx.grant.run(fn, { units: TYPE_CHECK_WORKER_UNITS })` (§4). Transcript lines keep their
  greppable shapes with the program name in place of the target name:
  `type-check: program unchanged since last pass, skipped (program keys 900ms)` /
  `type-check: program changed, running (program keys 900ms)`;
  `type-check: no program key — no buildinfo yet`;
  `type-check worker repo: cpu 86.6s, maxRSS 2.4 GB`; the warm-base and publish lines as today.
  The `N of M run concurrently` line goes (one worker). The `uncovered` hint no longer says "add
  its directory to a tsconfig include" for plugin files — an uncovered file is now one outside
  `plugins/`, `test/` or `*.config.ts`, and the hint says so.
- `type-check/shared/worker.ts`, `core/spawn-worker.ts`, `core/worker-protocol.ts`,
  `check/program-key.ts`, `check/pass-set.ts`, `check/fingerprint.ts`, `check/import-graph.ts`,
  `check/closure-cache.ts`, `check/outer-read-set.ts`: unchanged (all already take one program).
  The `selfSourceHash` set is unchanged in shape (flat `check/` + `shared/` + `discover.ts`), so
  every recorded program PASS is invalidated exactly once by this change, as intended.
- `checks/core/warm-base.ts`: unchanged; the pool simply gains a `repo` partition. Its first entry
  is published by the first run after merge (main's auto-build), and every fresh worktree seeds
  from it thereafter. Each *existing* worktree pays one cold run (~7–10 GB, 100–300 CPU-s) the
  first time it checks after rebasing onto this change; the old seven partitions age out in 14 days.

### 3. Build fast path

`cli/plugins/build/cli/internal/app-artifacts.ts` `fastValidationJobs`: the
`discoverTscTargets(root).filter(t => t.hasEntrypoint)` loop (three jobs today: `tsc server-core`,
`tsc central-core`, `tsc cli`) becomes one job `tsc repo` over `repoProgram(root)`, same body
(`materializeWarmBase` → `spawnTypeCheckWorker({ lintFiles: [] })` under `grant.run` with the same
weight as §4 → `publishWarmBase`). `hasEntrypoint` has no remaining reader and is deleted with
`TscTarget`.

### 4. Weighted grant: the worker spends two units

- `plugins/packages/plugins/semaphore/core/internal/semaphore.ts` — `run(fn, onWait?)` and
  `acquire(onWait?)` gain a weight: `run(fn, { weight?, onWait? })`. A waiter is a queue entry
  carrying its weight; the head waiter is admitted when `active + weight ≤ max` (FIFO, so a heavy
  waiter is never starved by light ones behind it, and two heavy waiters can never each hold half
  and deadlock — a weight is acquired atomically or not at all). `weight > max` throws at the call
  site: the clamp belongs to the layer that knows the ceiling, not here. `stats()` reports active
  weight. Existing single-weight behaviour is byte-identical (`weight` defaults to 1).
- `host-admission/core/internal/grant.ts` `Grant.run<T>(fn, opts?: { units?: number })`, and
  `server/internal/grant.ts` `grantOfUnits` forwards `weight: Math.min(units, grant.units)`.
  The clamp lives in the grant, once: a 1-unit inherited grant (`SINGULARITY_HOST_GRANT=1`) runs a
  2-unit request at weight 1 — the grant IS the ceiling, the same rule as "a reduced grant just
  runs the fleet at lower concurrency" — and can never wait forever. `inheritedGrant` is unchanged.
- The weight is declared where the cost is measured, in `type-check/core`:
  `TYPE_CHECK_WORKER_PEAK_BYTES = 7.2e9` (the transcript mean above, cited) and
  `TYPE_CHECK_WORKER_UNITS = Math.ceil(TYPE_CHECK_WORKER_PEAK_BYTES / PER_UNIT_BYTES)` = 2,
  importing `PER_UNIT_BYTES` from `@plugins/infra/plugins/host/plugins/host-admission/core` (the
  edge tooling → host-admission already exists through `CheckContext.grant`). A retune of the
  quantum reflows into the weight; nothing in host-admission names a consumer.
- Effect on this host (B = 9, backgroundLimit = 6): at most 4 type-check workers host-wide
  (≈ 29 GB at the mean peak, under the 32 GB ceiling) instead of 9 (≈ 40 GB at today's per-worker
  mean); the background lane admits 3 concurrent agent type-checks. Throughput still rises because
  each build's total CPU falls ~3.7×.

### 5. What the change deletes elsewhere

- **`checks/plugins/collected-dir-tsconfig-coverage`** (whole plugin): it asserts every collected-dir
  folder NAME appears in some tsconfig `include` glob. Under a blanket include it would fail on every
  dir, and its purpose is subsumed by the type-check coverage gate, which is per-file. Delete the
  plugin dir; `check.generated.ts` regenerates on build.
- **The DOM-less tripwire.** Five comments cite `tools` withholding DOM as the compiler-enforced
  reason for a design choice: `infra/safe-fetch/server/internal/ssrf.ts:38` (`Bun.BodyInit` over
  bare `BodyInit`), `plugin-meta/barrel-import/core/internal/stubs.ts:58` (structural `globalThis`
  probe), `infra/worktree/plugins/removal-audit/server/internal/channel.ts:26` and
  `infra/launcher/server/internal/{config-propagate.ts:26, boot.ts:994}` (the launcher must not
  reach `log-channels` → `endpoints`). Every one of those files is already checked under DOM by six
  other programs today, so the code needs no change — but after this change nothing fails if a
  bare DOM type or the `endpoints` chain reaches the launcher. Rewrite each comment to state the
  constraint as the design intent it is (keep the launcher's import closure small; prefer bun's
  namespaced types in server code) and drop the "tools tsconfig" justification. If the owner wants
  the launcher constraint *enforced*, the right rung is a `plugin-boundaries` deny rule
  (`launcher/server` ↛ `log-channels`, `endpoints`), filed as a follow-up task, not a second
  tsconfig.

### 6. Docs

- `type-check/CLAUDE.md`: rewrite "Shape" (one program), delete the false "shared `core` files are
  checked under every runtime's lib/types" invariant and the `web-core`-first ownership prose, rewrite
  "A target whose program is unchanged is skipped" as "the program is skipped when unchanged", the
  transcript-line list (§2), the warm-base section's "per target" wording, and add the weighted
  grant under "Host-wide worker budget". Record the environment measurement (§Context) so the
  isolation belief cannot come back.
- `checks/CLAUDE.md`: any "seven targets" prose; the autogen block regenerates.
- `host-admission/CLAUDE.md`: a "Weighted spend" paragraph under the grant section; the
  `PER_UNIT_BYTES` docblock in `core/internal/budget.ts` gains one line pointing at the consumer
  that now declares a multi-unit weight.
- Root `CLAUDE.md` "Available built-in checks → type-check": "builds each tsconfig target's program
  once" → "builds the one repo program once".
- After the build is green: one agent note under A.4 on the page (`write_agent_note`), with the
  before/after table from §Verification.

## Files

- `tsconfig.json` (rewrite); delete `tsconfig.test.json`, `tsconfig.tools.json`,
  `plugins/framework/plugins/web-core/tsconfig{,.app}.json`,
  `plugins/framework/plugins/{server-core,central-core,cli,tooling}/tsconfig.json`
- `plugins/framework/plugins/tooling/plugins/checks/core/discover.ts`, `core/index.ts`
- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/{index,prepare,prepare-worker,prepare-thread}.ts`,
  `core/{index,tsconfig-path}.ts` (delete `tsconfig-path.ts`; add the weight constants), `CLAUDE.md`
- `plugins/framework/plugins/tooling/plugins/checks/plugins/collected-dir-tsconfig-coverage/` (delete)
- `plugins/framework/plugins/cli/plugins/build/cli/internal/app-artifacts.ts`
- `plugins/packages/plugins/semaphore/core/internal/semaphore.ts` (+ its test)
- `plugins/infra/plugins/host/plugins/host-admission/core/internal/grant.ts`,
  `server/internal/grant.ts` (+ `grant.test.ts`), `CLAUDE.md`, `core/internal/budget.ts` (docblock)
- Comments only: `plugins/infra/plugins/safe-fetch/server/internal/ssrf.ts`,
  `plugins/plugin-meta/plugins/barrel-import/core/internal/stubs.ts`,
  `plugins/infra/plugins/worktree/plugins/removal-audit/server/internal/channel.ts`,
  `plugins/infra/plugins/launcher/server/internal/{config-propagate,boot}.ts`
- Tests: `type-check/check/prepare-thread.test.ts` (the fixture writes a root `tsconfig.json`
  with `include: ["src"]` instead of `plugins/framework/plugins/<fixture>/tsconfig.json`, and the
  expected plan is the singular shape); `program-key.test.ts` and `checks/core/warm-base.test.ts`
  use synthetic names and need no change beyond any `PlannedTarget` type rename.
- `CLAUDE.md` (root, one line); `docs/plugins-*.md` regenerate on build.

## Trade-offs, stated

- **Every miss parses the whole program.** Today an edit confined to one target runs that worker
  and skips the rest (a `tools`-only edit: 22 CPU-s / 1 GB). After, any edit runs the one worker,
  whose identical-tree floor is ~45 CPU-s / ~2.7 GB (the parse; tsc's own incremental engine then
  re-checks only the affected closure, thanks to the real signatures). The unchanged-tree case
  still skips everything. This is the price of not paying 3.7× on every other kind of edit.
- **A hub API edit is serial.** Today its importer closure is re-checked in up to seven processes
  in parallel; after, once, in one process. On a quiet host that can be up to ~1.3× the wall clock
  of today's largest worker; under the usual load (six demoted workers competing) the single
  worker gets a core to itself and comes out ahead. CPU is lower in every case.
- **`tools` loses its DOM-less environment** (§5). Accepted by the owner.
- **Editors load one ~11k-file project** for any file, where a server-only session used to load
  ~5.4k. Web sessions already loaded 9.8k.
- The per-program skip's `skipped N of M` histogram becomes a yes/no. The `cpu` / `maxRSS` line is
  still the instrument.

## Verification

1. **Coverage proof, before anything else.** Capture the union of the seven current programs'
   repo files from the pool (`~/.singularity/cache/tsbuildinfo/6.0.3/<target>/*.tsbuildinfo`,
   `fileNames` resolved as if at `.cache/tsbuildinfo/`, non-`node_modules` only; 8,252 today) into
   the scratchpad. After the change, `./equin check type-check --no-cache`, read
   `.cache/tsbuildinfo/repo.tsbuildinfo` the same way, and assert the new set ⊇ the union. Any
   file missing is a hole in `include`; extras are expected (the ~199 files no test reached).
2. `./equin test plugins/framework/plugins/tooling/plugins/checks plugins/packages/plugins/semaphore plugins/infra/plugins/host/plugins/host-admission`
   — the rewritten prepare-thread fixture, the weighted-semaphore cases (weight acquired atomically,
   FIFO, `weight > max` throws), the grant clamp (a 1-unit grant runs a 2-unit request).
3. Three consecutive `./equin check type-check` runs on this worktree, read from
   `~/.singularity/worktrees/att-1789665118-gl85/check-<runId>.log`:
   - cold (new partition): one `type-check worker repo: cpu …` line, ≈ 100–300 CPU-s, ≈ 7–10 GB;
     `warm base repo: cold, pool empty`; one `published 1 warm base labelled <sha>` line;
   - identical tree: `program unchanged since last pass, skipped`, zero worker lines;
   - one comment appended to a `web/` component: `running`, one worker ≈ 45 CPU-s / ≈ 2.7 GB.
4. `./equin build` (background) green, then `./equin build --skip-checks` shows a
   single `tsc repo` step and publishes a labelled base.
5. Before/after table for the page note: sum of worker CPU and simultaneous peak RSS on a cold
   miss (today ≈ 740 CPU-s / ≈ 30 GB from the table above) against the single worker's line; the
   admission check (`./equin check host-budget`, if present) still green with B unchanged.
6. One week later: `rg -h 'type-check worker repo' ~/.singularity/worktrees/*/check-*.log` —
   the distribution should sit between the ~2.7 GB warm floor and the ~7 GB API-edit peak, with the
   16 GB tail gone (it was `test` re-checking web-core's closure in parallel with web-core doing
   the same).

## As built (2026-09-19, `att-1789665118-gl85`)

Built as planned, by two Opus agents on disjoint file sets (the weighted grant; the layout), then
integrated and verified here. Deviations from the plan, and why:

- **The semaphore's positional `onWait` is gone**, not overloaded: `run(fn, { weight?, onWait? })`
  and `acquire({ weight?, onWait? })` are the one spelling, and the eight call sites moved
  (database client, endpoints implement, host-read-pool, browser-fetch pool, resource-runtime,
  the check runner). One options object is how the sibling `inflight` primitive already reads; an
  overload would have been a second spelling to keep in step forever.
- **The weight constants live in `type-check/core/worker-weight.ts`**: `TYPE_CHECK_WORKER_PEAK_BYTES
  = 7.2e9` (the `test` worker's transcript mean — the union program is that program plus 2.5 %) and
  `TYPE_CHECK_WORKER_UNITS = ceil(peak / PER_UNIT_BYTES)` = 2, imported by both the check and the
  build's fast path. The mean rather than the tail, matching what `PER_UNIT_BYTES` itself models.
- **The coverage gate skips when the tsconfig will not parse** (a discriminated `unparsed` arm), so
  one broken JSON file reports as tsc's one diagnostic instead of "every file is orphaned".
- **Two more stale comments** than the five the plan listed cited the deleted tsconfigs
  (`zero/cache-service/shared/internal/slot-sql.ts`, `passthrough/lint/no-unanchored-passthrough.test.ts`),
  plus `layout-harness/CLAUDE.md`'s "wiring footgun" section, which described the exact chore the
  single include removes. All rewritten. `plugin-registry-gen.ts`'s comment no longer names the
  deleted check.
- The deleted check plugin's workspace entry left `bun.lock`, and `./equin regen-generated`
  rebuilt the check registry and the docs (same pipeline the build runs).

### Verified

Tests: `./equin test` over the checks, semaphore and host-admission plugins — 228 pass, 1
fail. The failure is `withHostGrant grants at least one unit and runs fn`, a pre-existing case that
acquires a REAL host CPU share and timed out at bun's 5 s default while other agents' builds held
the pool (`all 6 fan-out children exited before granting a slot`); it runs before any code this
change touched. Re-run alone below.

Coverage proof: the union of the seven old programs' repo files (from the pool's buildinfos,
8,249 present in this tree) against the new `repo.tsbuildinfo`: **0 missing**, 8,250 repo files,
11,165 files with declarations (the old `test` program was 10,939).

Four consecutive `./equin check type-check` runs on this worktree, transcript lines verbatim:

| run | tree | lines |
| --- | --- | --- |
| 1 | cold, new `repo` pool partition | `program changed, running (program keys 644ms)` · `warm base repo: cold, pool empty` · `no program key — no buildinfo yet` · **`worker repo: cpu 616.3s, maxRSS 9.4 GB`** · `published 1 warm base labelled 6ef203d0d666` |
| 2 | identical | `ok (cached)` — outer read-set hit, no worker |
| 3 | one comment appended to a plugin's `web/index.ts` barrel | `program changed, running` · `warm base repo: kept local 8248/8250` · **`worker repo: cpu 77.1s, maxRSS 6.7 GB`** |
| 4 | that comment reverted (one unrelated comment edit since run 1) | `program changed, running` · `kept local 8249/8250` · **`worker repo: cpu 28.2s, maxRSS 2.6 GB`** |
| 5 | `./equin build` (full check pass, after codegen regenerated three files) | `program changed, running` · `kept local 8247/8250` · **`worker repo: cpu 43.3s, maxRSS 3.5 GB`** · `published 1 warm base labelled 6ef203d0d666 (kept 4, 1 on main)` |

Run 1 is the one-time cold cost of the new partition: it also re-linted every file, because the
tsconfig change flipped the global closure fingerprint. Run 4 is the whole-repo warm floor the plan
predicted (~45 CPU-s / ~2.7 GB): 28 CPU-s and 2.6 GB. Run 5 is a BUILD, which regenerates
registries before its checks and so always runs the worker: 43 CPU-s and 3.5 GB — the full
check suite green and the app deployed. Run 3 is above that floor because the edited
file is a barrel every importer's lint closure includes, not a leaf; the same edit under the old
layout ran the `web-core` AND `test` workers, each of this size, side by side. No type error and no
lint violation anywhere in the repo under the single program — the `tools` files compile with DOM
in scope, and the web files with bun types, exactly as the measurement said they already did.

Against the baseline table in Context (a cold miss ≈ 740 CPU-s across seven workers, ≈ 30 GB
simultaneously resident): one worker, 9.4 GB cold and 2.6 GB warm.

### Watch next

`rg -h 'type-check worker repo' ~/.singularity/worktrees/*/check-*.log` over a week: the
distribution should sit between the 2.6 GB floor and the ~7 GB API-edit peak, with the old 16 GB
tail gone. The 6.7 GB barrel-edit case (run 3) is worth one look with the closure cache's
re-lint count beside it, if it turns out to be the common shape.

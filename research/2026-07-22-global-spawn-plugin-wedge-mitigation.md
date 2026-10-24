# Plan — `infra/spawn` plugin: wedge-proof child processes (Stage 1: CLI/tooling)

## Context

bun 1.3.13 (unfixed through 1.4-canary) has a race where a `Bun.spawn` child
with piped stdio exiting during a pending stream pull wedges the event loop in
a permanent native microtask storm: ~100% CPU, kevent starved, children
zombify, the op never completes. Producer chain symbolicated from live field
specimens: [`2026-07-22-global-cli-op-wedge-symbolication.md`](./2026-07-22-global-cli-op-wedge-symbolication.md),
[`2026-07-22-global-cli-op-wedge-producer-fingerprint.md`](./2026-07-22-global-cli-op-wedge-producer-fingerprint.md).
Every `./equin build/check/push` wedge observed in the field is this bug.

Mitigation (and causal test): remove piped stdio from capture-shaped children —
redirect stdout/stderr to temp-file fds, read after exit. No stream, no pull
promise, nothing to wedge. This plan delivers it as a self-contained plugin +
full CLI/tooling migration + a chokepoint lint rule so the footgun cannot
regrow. **Scope decision (user): Stage 1 = CLI/tooling only; server migration
is Stage 2, filed as a follow-up task, gated on Stage 1 demonstrably stopping
the field cli-op-wedge reports.**

Verified load-bearing facts: bare `Bun.spawn(cmd)` defaults stdout to
**`"pipe"`** (empirically tested on 1.3.13) — even option-less calls are
exposed, settling the lint design as a chokepoint ban. Stage-1 inventory is
~113 files (96 from the original sweep + 17 plugin-contributed `check/` files
outside tooling + `server-core/scripts/backfill-pushes.ts`; coverage re-swept,
no other stragglers).

## 1. New plugin `plugins/infra/plugins/spawn/`

Mirror `plugins/infra/plugins/file-sink/` (impl in `core/` = runtime-neutral
Node with the load-bearing top comment; description-only `server/index.ts`
stub, no re-exports; registration automatic on build).

```
plugins/infra/plugins/spawn/
├── package.json                  # { "name": "@singularity/plugin-infra-spawn", "private": true, "version": "0.0.1" }
├── CLAUDE.md                     # bug, API, exception policy, Stage-2 note
├── core/
│   ├── index.ts
│   ├── internal/{types,spawn-captured,spawn-passthrough,git-roots}.ts
│   ├── spawn-captured.test.ts    # bun:test, real children
│   └── git-roots.test.ts
├── lint/
│   ├── index.ts                  # { name: "spawn-safety", rules, ignores } — jiti-loaded, NO @plugins imports
│   ├── no-raw-bun-spawn.ts
│   └── no-raw-bun-spawn.test.ts  # RuleTester, mirrors git-grep-safety's test
└── server/index.ts               # description stub (file-sink pattern)
```

**Prerequisite:** `spawn-priority` has no `core/` — move `backgroundArgv`/
`backgroundPrefix` impl to `plugins/packages/plugins/spawn-priority/core/`;
its `server/index.ts` keeps exporting them via same-plugin re-export
(`boostInteractiveQos` stays server-only). Needed so `spawn/core` can compose
demotion without breaking checks' `core→core` isolation.

Deleted: `plugins/framework/plugins/cli/bin/git/{worktree-root,main-repo-root}.ts`
(consumers redirect to the new canonical helpers).

## 2. API (`@plugins/infra/plugins/spawn/core`)

```ts
interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;  // full replacement, same contract as Bun.spawn
  stdin?: string | Uint8Array;               // whole-buffer via temp-file fd; EOF at end
  background?: boolean;                      // argv := backgroundArgv(argv)
  mergeStderr?: boolean;                     // 2>&1 into one fd; result.stderr === ""
}
interface SpawnResult {
  exitCode: number;                          // ≠0 is a legitimate result — caller branches
  signalCode: string | null;
  stdout: string; stderr: string;            // lazy cached utf8 decode
  stdoutBytes: Uint8Array; stderrBytes: Uint8Array;  // for byte-offset parsers (cat-file framing)
  resourceUsage: { maxRssBytes: number | undefined };
}
spawnCaptured(argv, opts?): Promise<SpawnResult>
spawnExpectOk(argv, opts?): Promise<SpawnResult>   // throws SpawnFailedError(argv/exitCode/signalCode/stdout/stderr)
spawnPassthrough(argv, { cwd, env, background, onSpawn }?): Promise<{ exitCode, signalCode, resourceUsage }>
  // stdout/stderr "inherit", stdin "ignore"; onSpawn exposes { pid, kill } for signal forwarding (inspect.ts)
getWorktreeRoot(cwd?): Promise<string>   // git rev-parse --show-toplevel
getMainRepoRoot(cwd?): Promise<string>   // dirname(resolve(git rev-parse --git-common-dir))
```

**Mechanics:** per call `mkdtempSync(os.tmpdir(), "sg-spawn-")` → write stdin
file if given → `openSync` numeric fds for in/out/err (merge reuses out) →
`Bun.spawn(argv, { stdin: inFd ?? "ignore", stdout: outFd, stderr: errFd })` →
`await proc.exited` → capture rusage → close fds, read files, `rmSync` in
`finally`. Raw numeric fds = plain kernel dup2, zero JS stream machinery in
either direction. Orphans on hard crash: OS tmpdir reclaim (repo convention).

**Root helpers:** built on `spawnExpectOk` — not-in-a-repo **throws** (today's
copies absorb to `""`, a latent path bug; fail-loud per repo rule). Memoized
`Map<resolvedCwd, Promise<string>>` — one spawn per process instead of ~50 per
check run. Collapses the 51-file `getRoot()` copy-paste epidemic.

**Deliberate non-goals** (in CLAUDE.md): no `timeoutMs` (op-wedge-watchdog owns
fleet protection), no `maxOutputBytes` (silent cap = absorbed failure), no sync
variant (the 3 `Bun.spawnSync` + 2 `execFileSync` sites buffer natively — no JS
streams, no wedge; untouched and rule-legal).

## 3. Lint rule `spawn-safety/no-raw-bun-spawn`

**Chokepoint ban** (sink-safety precedent): flag every `MemberExpression`
`Bun.spawn` (identifier or computed `"spawn"` literal — covers calls, aliasing,
`Bun["spawn"]`). `spawnSync` explicitly not matched. In-rule owner skip:
filename includes `plugins/infra/plugins/spawn/`. Rule file imports only
`@typescript-eslint/utils` (jiti cannot resolve `@plugins/*`).

Message: names the wedge + research doc, states the default-stdout-is-pipe
fact, enumerates the sanctioned doors with the import specifier, and the
policy for genuinely interactive children (file ignore + justification).

`ignores` (Stage 1): `**/*.test.ts`, `**/*.test.tsx`;
`plugins/**/server/**` (Stage 2, temporary, tracked by the follow-up task);
`plugins/framework/plugins/cli/bin/migrations-interactive.ts` (the ONE true
streaming site — `runDrizzleKitWithPrompts` + prompt parser **extracted out of
migrations.ts** into this file so the ignore is surgical); `research/**`
(the repro deliberately exercises the bug).

## 4. Migration map (Stage 1, ~113 files)

CLI (`plugins/framework/plugins/cli/bin/`):
- `push.ts`: `run` → 5-line adapter on `spawnExpectOk` (print cmd+stderr,
  `process.exit(1)` — preserves UX); `runAllowFail` → `spawnCaptured` (stderr
  printed after exit); `exec`/`runChecksSubprocess` → `spawnPassthrough` (+
  grant env).
- `build.ts`: `exec` → `spawnPassthrough`; `execBuffered` → `spawnCaptured`
  (StepOutput.lines rebuilt as stdout-lines then stderr-lines — cross-stream
  interleave was a nondeterministic pipe race anyway); `backgroundArgv`
  pre-wraps → `background: true`; root/branch/hooksPath spawns → helpers/
  `spawnCaptured`; the 2 `spawnSync` git sites stay.
- `release.ts` `run` → local wrapper (echo, `spawnPassthrough`, throw).
- `check.ts`, `regen-generated.ts`, `regen-migrations.ts` → `getWorktreeRoot`.
- `migrations.ts` → split interactive runner to `migrations-interactive.ts`
  (unchanged, lint-ignored); `resolveRef` → `spawnCaptured` (branch on
  exitCode); `listTreeFiles` → `spawnExpectOk`.
- `broadcasts.ts` (2) → `spawnCaptured`; `register-merge-drivers.ts` (3) →
  `spawnCaptured` (get; exit 1 = unset) / `spawnExpectOk` (set).
- `inspect.ts` self re-exec → `spawnPassthrough` with `onSpawn` (signal
  forwarding).

Checks core (`tooling/plugins/checks/core/`):
- `grep-code.ts`: `getRoot` → `getWorktreeRoot`; `gitGrepList` →
  `spawnCaptured` (exit 1 + empty = no matches stays); `readTreeBlobs`
  (cat-file --batch) → `spawnCaptured` with `stdin: requests`, parse
  `stdoutBytes` — verified: the parser already walks a fully-buffered
  Uint8Array after exit, framing unchanged.
- `tree-hash.ts`, `read-set.ts` (N+1 cat-file: flag only), `runner.ts`,
  `scripts/fix-shared-to-relative.ts`, `boundaries/core/check.ts`,
  `web-artifacts/check/index.ts` → helpers/`spawnCaptured` as shaped.
- `type-check/check/index.ts`: probes → helpers/`spawnCaptured`; worker spawn →
  `spawnCaptured` with `background: branch !== "main"`.

~46 tooling check plugins + 17 out-of-tooling check files (page/editor,
config_v2, database/migrations ×5, reorder, model-provider, facets,
infra/paths, layout-harness, data-view, infra/endpoints ×3, app-icon) +
`server-core/scripts/backfill-pushes.ts` — mechanical recipe: delete local
`getRoot()`, import `getWorktreeRoot`; remaining spawns → `spawnCaptured`.
`migrations-in-sync` drizzle-kit → `spawnCaptured` with
`stdin: new Uint8Array(20).fill(0x0d)`.

No migration: all `Bun.spawnSync`/`execFileSync`; `plugins/**/server/**`.

## 5. Execution phases

**Phase 1 — Fable agent (load-bearing), one pass:**
1. spawn-priority `core/` extraction.
2. spawn plugin complete (core + tests + CLAUDE.md + stub). **First test
   asserts numeric-fd stdio works on bun 1.3.13** (echo roundtrip, exit codes,
   binary fidelity, stdin roundtrip, mergeStderr, cwd/env, rusage,
   background) + a stress loop of fast-exiting noisy children as wedge smoke
   test.
3. Lint rule + rule test + final ignores.
4. Tricky migrations: grep-code, tree-hash, read-set, runner, boundaries,
   type-check, web-artifacts, build.ts, push.ts, migrations split,
   migrations-in-sync; delete cli/bin/git helpers.
5. Verify: `bun test plugins/infra/plugins/spawn plugins/framework/plugins/cli/bin`;
   `./equin build`. Full `./equin check` is expected to fail
   eslint ONLY on Phase-2 files — that residue is the batch to-do list.

**Phase 2 — five parallel Opus agents (mechanical batches):**
- A: `checks/plugins/{a–d}*` (~12) · B: `{e–m}*` (~11) · C: `no-*` (~12) ·
  D: `{p–w}*` (~11) + simple CLI files (broadcasts, register-merge-drivers,
  check, regen-*, release, inspect) · E: 17 out-of-tooling check files +
  backfill-pushes.ts.
- Each prompt carries the recipe + "mirror a Phase-1-migrated check
  byte-for-byte". Per-batch gate: `rg "Bun\.spawn\(" <files>` empty; `bun
  test` touched tests; `./equin check type-check` clean within the
  batch's own file set.

**Phase 3 — Fable (integration):** sweep `rg -l "Bun\.spawn\("` vs the ignore
list; full `./equin check` green; `./equin build`; check wall-time
sanity (root memo should measurably cut spawns); **file the Stage-2 follow-up
task via `add_task`**.

## 6. Stage 2 (deferred annex — content of the follow-up task)

Scope `plugins/**/server/**` (~65 sites, 38 files). Rough batches: (1)
launcher + worktree + database admin/fork — streaming exception: `pg_dump →
pg_restore` stdin chaining stays piped or moves to fifo/file handoff; (2)
runtime-tmux (~15 sites, mostly capture-shaped); (3) op-wedge-watchdog
forensics + rest. Gate: only after Stage 1 demonstrably stops field
cli-op-wedge reports. Each batch shrinks the server ignore glob.

## 7. Verification (end-to-end)

1. `bun test plugins/infra/plugins/spawn` — primitive + lint-rule tests (risk
   #1 gate: numeric-fd stdio).
2. `bun test plugins/framework/plugins/tooling/plugins/checks/core` —
   grep-code/read-set roundtrip suites over the migrated helpers.
3. Full `./equin check` — proves every check still finds its root and
   candidates (the checks are their own integration tests).
4. `./equin build` — regenerates registries (new plugin appears),
   deploys; then `./equin push` dry confidence via `check --scope tree`.
5. Field: watch `cli-op-wedge` reports over subsequent days — Stage-1 success
   criterion and the Stage-2 gate.

## 8. Open risks

1. **Numeric-fd stdio on Bun.spawn 1.3.13** — proven only by the Phase-1 unit
   test; fallback `Bun.file(path)` targets (still no JS streams). Test FIRST.
2. spawn-priority same-plugin server→core re-export vs barrel purity —
   expected legal; fallback: thin server/internal shim.
3. Behavior changes (accepted, audited in Phase 1): execBuffered loses
   cross-stream interleave; runAllowFail stderr prints after exit; root
   helpers throw outside a git repo instead of returning `""`.
4. Escape hatches remaining: `Bun.spawnSync` (safe but loop-blocking — fine
   for CLI; revisit server-side in Stage 2) and node:child_process async spawn
   (no Stage-1 call sites; bun's shim may share the native stream code — flag
   for Stage-2, possibly extend the rule).
5. Future legitimate streaming sites need an ignores entry — intended review
   pressure, mirroring git-grep-safety.

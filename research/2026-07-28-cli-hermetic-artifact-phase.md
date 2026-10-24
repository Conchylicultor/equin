# Decoupling `release` from the dev inner-loop `build`

## Context

`release`'s stated contract (`release.ts:424`) is *"Emit a portable, self-contained app
artifact … that serves a composition on a fresh host."* Its implementation
(`release.ts:484`) shells into the dev inner-loop `build`:

```
bun cli/bin/index.ts build --composition <c> --no-restart --skip-checks --allow-main
```

`build` requires a live local dev cluster. Attempting a real deployment to a bare
4-core Ubuntu server (49.13.197.105) failed at:

```
build.ts:1012  waitForPg → readDatabaseConfig → ENOENT ~/.singularity/database.json
```

Release needs exactly three outputs from that call: filtered composition registries,
the vite web dist, and generated migration SQL. Everything else `build` does exists to
make *this machine's running instance current*. So producing an artifact of the system
requires a live instance of that same system — a bootstrapping inversion with three
consequences:

1. **No bare host, no CI.** Any machine that builds must first be a provisioned dev box
   (gateway + embedded PG + a DB fork).
2. **The build is not hermetic.** It reads ambient machine state, so the artifact is a
   function of the developer's environment, not just of (source, composition).
3. **It compounds with `platformTag()`** (`release.ts:110-119`, `process.platform/arch`):
   the only way to ship a linux artifact is to own a linux machine that is already a
   equin dev box.

Intended outcome: a release can be cut on any bare host from a fresh `git clone`, with
the dev inner loop byte-identical.

Two premises worth recording, because both were wrong on first reading:

- `drizzle.config.ts` does **not** ENOENT on a bare host — it imports `readDatabaseConfig`
  from `@plugins/database/core`, which catches ENOENT/`SyntaxError` and returns
  `SYSTEM_PG_DEFAULTS` (`plugins/database/core/internal/config.ts:40-52`).
- The real second landmine is **`libpqEnv()`**. There are three copies of this reader with
  divergent failure semantics:

  | file:line | ENOENT behavior |
  |---|---|
  | `plugins/database/core/internal/config.ts:40` | tolerant → `SYSTEM_PG_DEFAULTS` |
  | `plugins/framework/plugins/cli/bin/paths.ts:28` | **throws** (bare `readFileSync`) |
  | `…/checks/plugins/migrations-in-sync/check/index.ts:13` | tolerant (hand-inlined) |

  `migrations.ts:220` calls the **strict** copy to build drizzle-kit's env. So even after
  `waitForPg` is gone, `generateMigration` — a step release genuinely needs — still
  ENOENTs on a bare host. `build.ts:1012` is the first crash; `migrations.ts:220` is the
  next one waiting.

---

## The seam

`build`'s `action()` (639-1705) conflates two jobs:

1. **Produce the artifact set** — a deterministic function of (source tree, composition,
   frontend mode). Filesystem + CPU + network-for-deps only.
2. **Deploy it into the live dev cluster** — PG readiness, DB fork, `build_runs` ledger,
   gateway specs and HTTP restarts, worktree-op state, compose-serve, the verdict contract.

Release needs job 1 and nothing else. The file's *helper functions* are already cleanly
factored along this line (pure-fs / git-mutating / DB / gateway groups); the entanglement
is entirely in the inline action's step sequencing.

**The repo already solved this exact problem once.**
`plugins/framework/plugins/tooling/plugins/codegen/core/regen-pipeline.ts` is the single
source of truth for repo-tree codegen, shared by `build` and the `regen-generated`
command; its docblock records *why* it is split into two functions ("to preserve build's
interleaving of DB/central steps"). This is the same shape, one level up.

### Why a second command, not `build --hermetic`

Both expose the same extracted module — the structural fix is identical either way. The
difference is what it costs `build`:

- The dev-only steps are **not contiguous**. They interleave at four points: top preflight
  (642-760), the PG/fork/ledger interlude (984-1043), `propagateConfigToUser` (1091-1094),
  and the deploy tail (1493-1705). A flag threads ~8 new conditionals through a 1000-line
  action, and every future edit must reason about both modes.
- A separate command means **`build.ts` gains zero new branches** — its diff is purely
  "these 300 lines became three calls", mechanically verifiable as a no-op. That is the
  requirement that the dev loop not change, enforced structurally rather than by testing.
- `--hermetic` would silently invalidate four existing flags (`--no-restart` redundant,
  `--allow-main` meaningless, `--serve-composition` contradictory, `--skip-checks` implied).
  `build.ts:652-661` already carries two such contradiction guards; the class accumulates.
- A flag does not *force* the extraction — it can be implemented as ten
  `if (!opts.hermetic)` guards with no shared module at all.

The CLI already registers 10 commands (`bin/index.ts:33-42`), several of which
(`regen-generated`, `regen-migrations`, `apply-migrations`, `serve-app`) exist precisely
because a shared pipeline needed a second, process-isolated caller. An 11th thin command
is idiomatic here, not a new category of thing.

---

## Design

**New module** `plugins/framework/plugins/cli/bin/commands/internal/app-artifacts.ts` —
the ordered artifact pipeline, with a `regen-pipeline`-style docblock recording the
ordering constraints and an explicit **out-of-scope list** (waitForPg,
waitForWorktreeDatabase, run-ledger, gateway HTTP, worktree-op, compose-serve,
propagateConfigToUser).

`commands/internal/` (not a plugin) is right: it already holds extracted build stages
(`compose-serve.ts`, `dist-publish.ts`), both consumers are CLI commands, and it keeps
`bin/`-only imports (`../profiler`, `../build-lock`, `../paths`) legal.

**New command** `plugins/framework/plugins/cli/bin/commands/build-composition.ts` →
`./equin build-composition --composition <name>`. Named to mirror the `--composition`
flag it replaces; deliberately **not** `build-artifacts`, which would collide with build's
existing `--artifacts` (the per-plugin web-artifacts pipeline — an unrelated concept that
the new command always forces *off*).

### Module API

```ts
/** Observability seam. build passes its real profiler; build-composition passes no-ops.
 *  Shaped to `buildProfilerStart` exactly so build's spans stay byte-identical. */
export interface ArtifactHooks {
  span: (id: string, phase: string, label: string) => (info?: { maxRssBytes?: number }) => void;
  log: (line: string) => void;
  recordFootprint: (label: string, maxRssBytes: number | undefined) => void;
}

export type HeavyJob = (grant: Grant) => Promise<StepResult>;

export function resolveFrontendMode(opts: {...}): { artifacts: boolean; why: string };

/** Stage 1 — build.ts:942-981. bun install → registry codegen → composition registry. */
export function prepareCompositionSources(opts: {
  root: string; composition: string | null; hooks: ArtifactHooks;
}): Promise<void>;

/** Stage 2 — build.ts:1046-1088. migrations → manifest codegen → authored-override seed. */
export function generateAppSources(opts: {
  root: string; worktreeName: string;
  migration: { name?: string; reset?: boolean; custom?: boolean; answers?: MigrationAnswer[] };
  hooks: ArtifactHooks;
}): Promise<void>;

/** Stage 3 — build.ts:1104-1105, 1141-1401, 1465-1490. Build lock + host CPU grant,
 *  runs `companions` ∥ the frontend build, writes .build-commit/.build-id, publishes. */
export function buildAndPublishWebDist(opts: {
  root: string; webDir: string; buildId: string;
  composition: string | null; artifactsMode: boolean; minify: boolean;
  lane: Lane; background: boolean;
  companions: HeavyJob[];
  admission: { gated: boolean; deps: ValveDeps };
  onLockGranted?: () => void;
  hooks: ArtifactHooks;
}): Promise<{ steps: StepResult[]; stagingPath: string; livePath: string; buildCommit: string }>;

/** The `--skip-checks` validation set, so both callers share one definition. */
export function fastValidationJobs(opts: {...}): Promise<HeavyJob[]>;

export function acquireArtifactLock(webDir: string): Promise<void>;
```

Design notes:

- **`codegenStep` is derived inside the module** from `hooks.span`, reproducing build's
  `pluginDocs → build:validation`, else `build:codegen` mapping (`build.ts:625-634`). The
  two callers cannot drift on span naming.
- **`companions` is honest, not a workaround.** The heavy section is "one host grant, N
  heavy jobs, one of which is the frontend." Validation is not artifact production, so it
  is injected. `build` passes its full-checks job (which needs `check.log` + per-check
  `pushBuildSpan` — build-specific observability); both callers get the fast set from
  `fastValidationJobs`.
- **Failure is a type, not a value.** Every stage resolves or throws; no `process.exit(1)`
  inside the module. If any `StepResult.success === false`, stage 3 `rm`s the staging dir
  and throws `ArtifactBuildFailed { steps }`. `build` catches it and calls the existing
  `failBuild` with today's exact wording; `build-composition` catches and exits 1. The one
  documented exception: `generateMigration` already exits internally on a migration
  prompt — leave it, and record that stage 2 may terminate the process (unchanged today,
  and `release` relies on that exit code).

### `build`'s action after the change

Identical order; three call-outs replacing three blocks, nothing crossing a boundary:

```
642-940   unchanged, except:
          657-686 → const frontendMode = resolveFrontendMode({...})
          879-893 → await profiler.wait("build-lock", () => acquireArtifactLock(webDir));
                    setWorktreeOpPhase(...); profiler.markGranted(); await sweepDistLeftovers(...)
942-982   → await prepareCompositionSources({ root, composition, hooks });
984-1043  unchanged  (central routes, central.json, waitForPg, waitForDatabase, row mint)
1046-1088 → await generateAppSources({ root, worktreeName: name, migration, hooks });
1091-1094 unchanged  (propagateConfigToUser)
1096-1402 → companions = opts.skipChecks ? await fastValidationJobs(...) : [fullChecksJob(...)]
            publishLane(branch === "main");
            const { steps, livePath, buildCommit } = await buildAndPublishWebDist({...});
            // catch ArtifactBuildFailed → existing failBuild(...) at 1451-1461
1404-1705 unchanged
```

`hooks` in `build` is literally `{ span: buildProfilerStart, log: console.log,
recordFootprint }` — every span id/phase/label and every `maxRSS` line preserved by
construction.

### The new command

```
./equin build-composition --composition <name>
    [--migration-name <slug>] [--reset-migration] [--custom-migration]
    [--migration-answers <json>] [--no-minify]
```

Action: `markBuildInProgress()` → resolve root/name → `resolveFrontendMode` (always
monolithic when `--composition` is set) → `buildId = <shortCommit>-<Date.now()>`
(`SINGULARITY_BUILD_ID` deliberately *not* consulted — a release is not a build run) →
stages 1-3 with `lane: "interactive"`, `admission: { gated: false }` → print artifact
paths; on `ArtifactBuildFailed` print the step roster and exit 1.

`--composition` is **required**. No branch guard, no `--allow-main`, no `--no-restart`,
no `--skip-checks` — those flags stop existing because the deploy they gate stops existing.

Do **not** add it to `INSPECTED_COMMANDS` (`inspect.ts:35`) — that would insert a re-exec
layer into release's process tree for no benefit.

**Hard constraint (docblock + check):** `build-composition.ts`'s transitive import set must
be a *subset* of `build.ts`'s. The ESM-freeze invariant documented in `regen-pipeline.ts`
(Bun freezes a module on first `import()`; a stale barrel makes `generateConfigOrigins`
prune freshly-authored overrides) holds today only because build's process imports nothing
reaching a plugin barrel before `regenerateManifestCodegen` arms `setPreBarrelImportGuard`.
Keeping the import set a subset makes that inherited, not re-derived.

### `release.ts` still shells out

Replace `release.ts:483-497` with a `build-composition` invocation; update the comment at
478-482.

**Why not call the module in-process:** `release.ts` statically imports plugin barrels at
module load — `resolveIconSvgNodes` (line 29), `runAssetMirrorPrewarm` (30),
`propagateConfigToUser` (31), `buildPluginTree` (23). ESM imports are hoisted and evaluated
before the action body runs. Calling `generateAppSources` in-process would run
`regenerateManifestCodegen` in a process whose barrels are already frozen —
`setPreBarrelImportGuard` would never fire, and `pruneOrphanedConfigFiles` would delete
freshly-authored config overrides. That is exactly the silent corruption
`regen-pipeline.ts:96-118` documents. **Process isolation is the correctness boundary, not
an implementation detail.**

This is not the same coupling relocated: `build-composition`'s contract *is* release's
phase-1 need, its argv surface is one required flag plus migration passthrough, and it has
a typed in-process twin that `build` also calls — so the two callers cannot drift.

Secondary wins: release stops passing `--allow-main` (the DANGER flag agents are told never
to use, currently required on every release from main), stops entering `runComposeServe`
(it reaches it today via the `--no-restart` path at `build.ts:1615`, hitting the
`!artifactsMode` skip), and stops emitting `build_runs` rows / worktree-op markers /
build-progress entries that pollute the build Gantt with runs that are not builds.

No change to `plugins/release/server/internal/run-release.ts` — it spawns
`./equin release`, which is untouched.

---

## The `readDatabaseConfig` / drizzle fix

### One reader, one failure semantics

- Add `libpqEnv()` to `plugins/database/core/internal/config.ts` (trivially derived from
  `readDatabaseConfig`); export from `plugins/database/core/index.ts`.
- **Delete** `readDatabaseConfig` (`paths.ts:26-32`) and `libpqEnv` (`paths.ts:34-42`).
  Keep `DATABASE_CONFIG_PATH` as a re-export from `@plugins/database/core`.
- **Delete** the inlined copy at `migrations-in-sync/check/index.ts:11-28`. No cycle risk —
  that module's only import is `@plugins/infra/plugins/paths/core`, and the sibling
  `plugins/database/plugins/migrations/check/index.ts:6-10` already documents this
  "use the core barrel, it is import-safe by design" pattern.
- Update the stale comment at `plugins/infra/plugins/paths/check/index.ts:19` and the three
  import sites (`build.ts:24-31`, `migrations.ts:12`, the check).

**One intentional, scoped behavior delta:** `waitForPg` (`build.ts:295-296`) currently
throws ENOENT when `database.json` is absent; after unification it falls through to the
existing `config.services.length === 0 → return` ("externally managed DB"), and
`waitForWorktreeDatabase` produces the real, actionable error. On any dev host
`database.json` always exists (`./equin start` writes it), so no dev-loop invocation
changes.

### `drizzle.config.ts` is codegen config, not database config

Verified: the only drizzle-kit subcommand this repo ever runs is `generate`
(`migrations.ts:209`, `migrations-in-sync/check/index.ts:62-70`). `apply-migrations.ts`
builds its own connection string and never loads this config. `generate` performs a pure
snapshot diff against `./data` and opens no connection. So the file's `readDatabaseConfig()`
call and `SINGULARITY_WORKTREE` throw are ceremony that make a filesystem codegen step
*look* DB-entangled — which is why the hermetic phase felt impossible.

Rewrite `plugins/database/plugins/migrations/drizzle.config.ts` to keep `dialect`, the
`schema` globs and `out`; drop `readDatabaseConfig()` and the `SINGULARITY_WORKTREE`
requirement; satisfy drizzle-kit's `Config` type with an explicit non-connecting sentinel
`postgres://codegen@codegen.invalid/codegen`. The reserved `.invalid` TLD guarantees any
accidental dial fails loudly rather than silently reaching a real database. Header comment
records that any dialing subcommand (push/migrate/studio) is unsupported through this
config.

Turn that comment into an enforced invariant: add
`plugins/database/plugins/migrations/check/drizzle-kit-generate-only.ts` (registered in
that plugin's `check/index.ts`) failing on any `drizzle-kit` invocation other than
`generate`.

Then **remove `libpqEnv()` from `migrations.ts:220`** — nothing downstream reads `PG*` for
a `generate`, and that removal is what makes stage 2 provably hermetic. Keep
`SINGULARITY_WORKTREE` in the child env (schema files are import-safe without it —
`client.ts:16-22` defers the throw to first query — but leaving it keeps the dev loop
byte-identical). Separate commit so it can be reverted independently.

---

## Per-step disposition

| step | hermetic? | why |
|---|---|---|
| `bun install` (946-950) | **YES** | precondition of vite, drizzle-kit, tsc *and* release's own vendoring (`embeddedNativeDir`/`pgbouncerNativeBin` throw "run `bun install` first"). Network + fs, never host-cluster. Including it is what makes a fresh `git clone` work. |
| `ensureHooksPath` (691-693) | **NO** | mutates the user's `core.hooksPath` for commit-trailer attribution. A dev-workstation self-heal; a release host has no conversations to attribute. |
| `registerMergeDrivers` (695-697) | **NO** | same class — git config mutation serving the push/merge flow. |
| branch guard (699-715) | **NO** | exists to stop agents *deploying to the dev cluster* from main. A release has no deploy. Keeping it would force every release from main to pass `--allow-main` — routinising a DANGER flag erodes it. Dropping it is a security improvement. |
| `checkBroadcasts` (717-719) | **NO** | agent-facing inner-loop message channel; nobody watches a release host's stdout. |
| build lock (879-890) | **YES** | non-obvious but load-bearing: release is serialized against concurrent builds today *only because* it shells `build`, which takes `webDir/.build.lock`. Dropping it lets a concurrent `./equin build` race the release's codegen and dist publish. Plain filesystem symlink — bare-host safe. |
| host CPU grant (1374-1401) | **YES** | `createHostSemaphore` mkdir-p's `~/.singularity/cpu-slots` (`host-semaphore.ts:302,377`), so it works bare, and a 4-core box is exactly where bounding vite/tsc fan-out matters. Shared module ⇒ identical admission semantics for both callers. |
| duress valve | **YES, inert** | `isUnderDuress()` with no latch returns false, so `holdThroughValve` returns `"cleared"` immediately and never reaches `fs.watch` (`admission-valve.ts:96-99`). `build-composition` passes `gated: false` anyway. |
| `propagateConfigToUser` (1091-1094) | **NO — stays in each caller** | build targets `~/.singularity/config/<worktree>`; release targets `<out>/config-seed`. Same function, different sink — that *is* the parameterization. Mirrors `regen-pipeline.ts`'s own out-of-scope note. |
| `seedAuthoredOverrides` (1080-1088) | **YES** | repo-tree codegen whose output `propagateConfigToUser` reads; release vendors that config into the bundle and gets it today via the nested build. It mints `@review` markers into the checkout during a release — today's behavior; note it in the docblock rather than changing it. |
| build-progress / profile / verdict guard | **NO** | keyed to the worktree's dev artifact layout and the build Gantt. A release has its own durable artifact (`release-logs-<id>.json`). The module takes `hooks` so build's instrumentation is unchanged and the new command passes no-ops. |
| `markBuildInProgress` (642) | **YES, in both actions** | idempotent flag meaning "a dist rewrite is in flight, dist-comparing checks must skip". True for a release too. |
| validation (checks / runtime tsc) | **parameter** | not artifact production, but must share the one grant. The new command injects `fastValidationJobs()` — what release gets today via `--skip-checks`, including `schema-files-loadable` (`alwaysRun: true`), the net that catches a silently-dropped table in the release's migration set. |

---

## Risks

1. **Span drift in `build-profile-*.json`.** Mitigated structurally: `hooks.span` *is*
   `buildProfilerStart`, and the `codegenStep` id→phase mapping moves as a unit. Verify by
   diffing the `(id, phase, label)` tuple set before/after.
2. **Step-roster / `build.log` drift.** `printStepResults`, `pushBuildStepLog`,
   `orderStepsForDisplay` and the `failBuild` wording all stay in `build.ts`; the module
   only *produces* `StepResult[]`.
3. **Reordering.** Stage boundaries fall exactly at 942/982, 1046/1088, 1104/1490 — the
   dev-only interlude (984-1043) and `propagateConfigToUser` (1091-1094) stay put between
   them. Nothing crosses.
4. **`flushFootprint` seam.** `recordFootprint` currently appends to a closure array
   (897-923); route it through `hooks.recordFootprint` so `bun install` and
   `drizzle generate` maxRSS lines still land in the synthetic `resourceUsage` step.
5. **ESM-freeze regression.** Enforce "import set ⊆ build.ts's" via docblock plus a check.
6. **Staging leak on failure.** The `rm(stagingPath)` at 1450 must move into stage 3's
   throw path, or failed artifact builds leak staging dirs (`sweepDistLeftovers` would
   cover it next run, but relying on that is the silent-cleanup pattern this repo dislikes).
7. **Vestigial `build --composition`.** After this lands it has no consumer (verified: only
   `release.ts` used it). Removed in step 8 along with the `--artifacts`+`--composition`
   guard (658-663) and the "composition builds are always monolithic" special case
   (679-681) — a ~30-line simplification. Staged separately to keep the extraction
   independently revertible. `--serve-composition` is unrelated and stays.

---

## Verification

**A. Dev-loop byte-identity (the load-bearing gate).** At the pre-change commit run
`./equin build` twice; keep `build-profile-<id>.json`, `build-logs-<id>.json`,
`build.log`, and `sha256sum` of the published dist. Apply the change, rebuild, and assert:
identical `(id, phase, label)` span set; identical step-roster labels and order; identical
`grep maxRSS build.log` label set; identical dist hashes (excluding `.build-id`/
`.build-commit`). Repeat with `--skip-checks` and with a schema change requiring
`--migration-name` (proves stage 2's prompt/exit path still terminates correctly).

**B. Bare-host simulation, locally.** `SINGULARITY_DIR` is env-overridable
(`plugins/infra/plugins/paths/core/internal/paths.ts:51`):

```bash
SINGULARITY_DIR=$(mktemp -d) bun plugins/framework/plugins/cli/bin/index.ts \
  build-composition --composition website
SINGULARITY_DIR=$(mktemp -d) ./equin release --composition website --target web --dev
```

Both must succeed. Assert the temp dir afterwards contains no `database.json` and no
`worktrees/*/spec.json`.

**C. Negative assertion.** Run B with the gateway and Postgres stopped. Grep the new
command's transitive imports for `waitForPg`, `waitForWorktreeDatabase`,
`createBuildRunRecorder`, `markWorktreeOpStart`, `writeWorktreeSpec`,
`runComposeServeStage`, `localhost:9000` — all absent. Encode as a `./equin check` so
the decoupling cannot silently regress.

**D. Real bare host (the actual bug).** Fresh Ubuntu box with only `git`, `bun`, `go`:
`git clone` → `./equin release --composition website --target web` → run the emitted
self-extracting binary → the app answers on the RELEASE.json port. This is the acceptance
test for the whole plan. (49.13.197.105 is already provisioned with bun 1.3.14 + go 1.23.4
and the source at `/opt/singularity`.)

**E. Concurrency.** Start `./equin build` and `./equin release` simultaneously
in one checkout; the second must block on `webDir/.build.lock` rather than interleave.

**F. Checks + unit tests.** Full `./equin check` (`migrations-in-sync` must still
pass after the `libpqEnv` unification; the new `drizzle-kit-generate-only` check must pass).
Add `bun:test` for `libpqEnv()`/`readDatabaseConfig()` under an empty temp
`SINGULARITY_DIR`, `resolveFrontendMode`, and the stage-ordering contract with mocked hooks.

**G. Release plugin UI path.** Trigger a release from Studio (`triggerRelease` → detached
`./equin release`); confirm `release_runs` closes cleanly and the streamed log shows
`build-composition`, not `build`.

---

## Ordered steps

1. **Unify the DB config reader** — `libpqEnv` into `@plugins/database/core`, delete the two
   duplicates, fix 3 import sites + the paths-check comment, add the temp-`SINGULARITY_DIR`
   unit test. *Independently valuable and revertible.*
2. **De-DB `drizzle.config.ts`** + the `drizzle-kit-generate-only` check + drop `libpqEnv()`
   from `migrations.ts:220`. Verify `migrations-in-sync` and a real `--migration-name` build.
3. **Create `commands/internal/app-artifacts.ts`** — three stages, `resolveFrontendMode`,
   `fastValidationJobs`, `acquireArtifactLock`, `ArtifactBuildFailed`, docblock with
   ordering constraints + out-of-scope list.
4. **Rewire `build.ts`** to call them. Run verification A. Zero behavioral diff.
5. **Add `commands/build-composition.ts`** + register in `bin/index.ts:33-42`. Run B/C.
6. **Point `release.ts:483-497` at `build-composition`.** Run B (full release), E, G.
7. **Bare-host acceptance** (verification D).
8. **Follow-on:** remove `build --composition` and its two special cases; update docs
   (`cli/CLAUDE.md`, `plugins/release/CLAUDE.md:27`, `web-core/CLAUDE.md:56`,
   `web-artifacts/CLAUDE.md:9`, and the `--composition` references in
   `plugin-registry-gen.ts:421,497`, `run-prewarm.ts:7`, `plugins-active.ts:12`) — the
   `plugins-doc-in-sync` check fails otherwise. Run `./equin check`.

---

## Critical files

- `plugins/framework/plugins/cli/bin/commands/build.ts`
- `plugins/framework/plugins/cli/bin/commands/release.ts`
- `plugins/framework/plugins/cli/bin/paths.ts`
- `plugins/framework/plugins/cli/bin/migrations.ts`
- `plugins/database/core/internal/config.ts`
- `plugins/database/plugins/migrations/drizzle.config.ts`
- `plugins/framework/plugins/tooling/plugins/codegen/core/regen-pipeline.ts` — the precedent
  `commands/internal/app-artifacts.ts` must mirror

## Out of scope

Cross-platform artifacts (`platformTag()` at `release.ts:110-119` remains host-only) and the
missing deploy last mile (the `deploy` app has a server registry, SSH, and health probes but
no step that ships an artifact). Both are separate plans; this one only makes a release
cuttable on the host that will run it.

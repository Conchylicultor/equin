# One build verb — the artifact half

Phase 2 of [`2026-08-17-global-composition-build-serve-model.md`](./2026-08-17-global-composition-build-serve-model.md).

## Context

There are two CLI commands that produce a composition's artifacts, and neither is
named "build this composition":

- `./equin build` deploys **this checkout** into the live dev cluster. It
  cannot build a composition at all.
- `./equin build-composition --composition X` produces **one composition's**
  artifact set hermetically — filtered registries, migration SQL, web dist — with
  no cluster contact. It is what `release` shells into.

They are the deploy half and the artifact half of one pipeline (both drive
`bin/commands/internal/app-artifacts.ts`), but the naming hides that, and there
is no way to spell "build composition X".

This phase folds the artifact half into `build` as `--composition <name...>`
(variadic) plus `--hermetic`, and deletes `build-composition`. The *serve* half
of `--composition` — building and serving a composition into the dev cluster from
any checkout — is Phase 4 and is deliberately out of scope: it needs the
namespace rule (Phase 3) and the per-composition vendor set, neither of which the
hermetic path requires. Hermetic writes no `spec.json` and already resolves its
own vendor set, which is exactly why this half can land alone.

## Target surface

| invocation | behaviour |
|---|---|
| `build` | Unchanged, byte-for-byte. Deploys the checkout; no filtered registry. |
| `build --hermetic --composition sonata` | What `build-composition --composition sonata` did today. |
| `build --hermetic --composition sonata website` | Both, sharing one install / codegen / validation pass; one dist each. |
| `build --composition sonata` (no `--hermetic`) | **Refuse, exit 1**, naming Phase 4. |
| `build --hermetic` (no `--composition`) | **Refuse, exit 1** — `WebDistTarget.release` has no composition to key on. |
| `build --hermetic --composition singularity` | **Refuse, exit 1.** See "The `singularity` refusal" below. |
| `--hermetic` + `--allow-main` / `--skip-checks` / `--no-restart` / `--serve-composition` | **Refuse, exit 1.** Deploy-only; inert on this path, and a silently-inert `--skip-checks` reads as "I skipped validation". |
| `--migration-*`, `--no-minify` | Valid on both paths, ungated (both commands already take all five). |

`--hermetic` and `--composition` stay orthogonal *in meaning* — Phase 4 deletes
one guard rather than re-plumbing a flag whose meaning silently flipped.

### The `singularity` refusal is load-bearing, not pedantry

`--hermetic --composition singularity` would emit
`server.composition.singularity.generated.ts` into the checkout, and
[`select-registry.ts:43`](../plugins/framework/plugins/server-core/bin/select-registry.ts)
picks that file for main's backend on its next spawn purely on file presence. It
is byte-identical today by exactly the equivalence `plugins-registry-in-sync`
proves — "safe by coincidence, created by a path nobody expects" is how the
pre-S1 checkout-global registry bug worked. Phase 1's doc states the rule
directly: *"Do not emit `<dir>.composition.singularity.generated.ts` from any
path."* Reopening it is Phase 3/4's job (stop emitting into the checkout, or make
`selectRegistry` require more than presence).

## Shape: one verb, two postures, one shared pipeline

`build.ts` owns the flags and branches **as the literal first statement** of its
action into `runHermeticBuild()` in a new
`bin/commands/internal/hermetic-build.ts`. The 1100-line deploy body is not
touched.

This is not about file length. `build.ts`'s action arms, in its first ~350 lines
and interleaved with real work: `openBuildProgress`, `createOpProfiler`,
`createBuildRunRecorder`, `markWorktreeOpStart`, `process.on("exit", …)`,
`installVerdictGuard`, `installFatalSignalExit`, `writeBuildReceipt`. **Contract
(a) — stage 2 exits `2` on a drizzle rename/create prompt and `1` on a missing
`--migration-name`, and nothing may rewrite or bury those — is the statement that
this set is empty on the hermetic path.** Inline, that invariant survives only as
~20 scattered `if (!opts.hermetic)` guards; the 21st exit hook gets added without
one and `MIGRATION_PROMPTS_DETECTED` disappears under a `BUILD FAILED` banner.
Branch-once-and-delegate makes "no deploy machinery is armed" structural: the
hermetic path never enters the function that arms it.

The repo convention already places exactly this in `internal/` — CLAUDE.md: *"when
it is an ordered stage sequence rather than a helper"*. `compose-serve.ts` is the
precedent.

Contract (b) — **`release` keeps shelling out to a fresh subprocess** — is
unchanged: `release.ts` statically imports plugin barrels at module load, so
process isolation stays the correctness boundary. Only the argv changes.

## The guard, re-expressed

`cli:build-composition-import-subset` compared two command files' module sets. It
becomes vacuous with one file — but more importantly, **it never measured the
property it claimed to protect.** Measured on this tree: `bin/cli.ts` statically
reaches **14 plugin server barrels** already (`release.ts` pulls
`icon-picker/server`, `release/bundles/server`, `asset-mirror/server`, …). Every
`./equin build` has always run with those frozen. "No plugin barrel in the
CLI's static closure" is false today and always was.

A frozen *barrel* is harmless while everything it reaches is stable. The hazard is
its **generated inputs** changing mid-run:

> Bun freezes a module on its first `import()`. Stage 2
> (`generateAppSources` → `regenerateManifestCodegen`) regenerates every
> pre-barrel manifest and then imports every barrel to collect config_v2
> descriptors. A manifest frozen at CLI load is rewritten on disk and never
> re-read — `generateConfigOrigins` sees the previous run's descriptor set and
> `pruneOrphanedConfigFiles` **deletes a freshly-authored config override**.
> Silent data loss, no failing step.

So the replacement asserts: **no module in the CLI process's import closure may
reach a registered pre-barrel or post-web codegen manifest.** The five manifests
come from `preBarrelManifests` / `postWebManifests` in `codegen/core`, so the list
cannot drift.

This is the **only** mechanical protection against a load-time freeze:
`assertPreBarrelManifestsFresh` re-renders and compares **to disk** — on a
load-time freeze the disk copy is fresh, so it passes green while memory is
stale. `pre-barrel-manifests-complete` answers a different question (is a
barrel-reachable manifest registered at all). Neither sees this.

Green today: none of `data-views`, `custom-utilities`, `fields eager`,
`web-tiers`, `reorderable-slots` is in the closure.

**Scope, stated rather than implied.** Registry-phase outputs
(`check.generated.ts`, `data-dirs.generated.ts`, `auto-stubs.generated.ts`) *are*
in the closure and *are* rewritten by stage 1 — out of scope on purpose: their
staleness costs one run of registry content (loud or benign), not silent deletion
of authored data, and they arrive through `paths/server`, `checks/core` and
`barrel-import/core`, which the CLI cannot stop importing.
`icon-svg-map.generated.ts` comes from a hand-run script, never a build stage.

## Files

### `bin/commands/internal/app-artifacts.ts`

`prepareCompositionSources` goes variadic — one walk for N compositions is the
whole point:

```ts
export async function prepareCompositionSources(opts: {
  root: string;
  /** `[]` = a plain build (every filtered registry is per-NAME, so it emits none). */
  compositions: readonly string[];
  hooks: ArtifactHooks;
}): Promise<void>;

/** Every id must name a manifest entry. Exported so a caller can fail in ms, before ensureDeps. */
export function assertKnownCompositions(ids: readonly string[]): void;
```

Body: keep the `compositionRegistry` span emitted **unconditionally** (so
`build`'s Gantt stays byte-identical) and move the `if` inside it. One
`buildPluginTree({ skipBarrelImport: true, facets: true })` walk, then loop
`flattenManifest` → `resolveComposition` → `generateCompositionRegistry` per
name. All N registries are written before stage 3 imports any of them
(`compositionFleetSource` does a per-file `import(registryFile)`).

`generateAppSources`, `fastValidationJobs`, `buildAndPublishWebDist`,
`WebDistTarget`, `webDistPath`, `acquireArtifactLock` — **no signature changes**.

Docblock: `build-composition` → `build --hermetic`; the "any NEW caller must keep
its import set a SUBSET of `build.ts`'s" paragraph is now false framing — replace
with the process-level property and the new check id. Keep the `release`
shells-out paragraph verbatim.

### `bin/commands/internal/hermetic-build.ts` (new)

Today's `build-composition.ts` body, generalised to N. Its docblock is today's
header, edited: the "deliberately ABSENT" list stays verbatim — **it is now the
definition of what `--hermetic` turns off**.

```ts
export async function runHermeticBuild(opts: {
  compositions: readonly string[];
  migration: { name?: string; reset?: boolean; custom?: boolean; answers?: MigrationAnswer[] };
  minify: boolean;
}): Promise<void>;

/** Deploy-only flags + phase-scoped refusals under --hermetic. One message per conflict; [] = ok. */
export function hermeticFlagConflicts(opts: {
  composition?: string[]; allowMain?: boolean; skipChecks?: boolean;
  restart: boolean; serveComposition?: string;
}): string[];
```

Ordered body:

1. `markBuildInProgress()`.
2. `assertKnownCompositions()` — **before** `ensureDeps`, so an unknown id is a
   sub-second error, not a 20-minute one.
3. `root = await getWorktreeRoot()`; `name = checkoutWorktreeName(root)` (the
   named spelling of `basename`, and the one `release` resolves the dist
   through — the two processes agree by construction).
4. `buildId = <shortCommit>-<Date.now()>`. Keep verbatim the comment on why
   `SINGULARITY_BUILD_ID` is neither read nor written.
5. `acquireArtifactLock(resolve(root, WEB_CORE_RELATIVE))`.
6. `sweepDistLeftovers` for **all N** dists up front, so the documented invariant
   ("before any staging dir exists") stays literally true.
7. `reapLegacyCheckoutDist` once.
8. Console-only `hooks` (verbatim).
9. Stage 1 with the full list.
10. Stage 2. **Standalone comment: may terminate the process (exit 2 / 1);
    nothing above or below installs an exit hook, signal handler or verdict
    guard.** That is contract (a).
11. `fastValidationJobs` **once per invocation**.
12. Per composition, sequentially: `buildAndPublishWebDist` with
    `target: {kind:"release", worktree: name, composition}`, `materialize: true`,
    `experimental: false`, `lane: "interactive"`, `gated: false`, and
    `companions: i === 0 ? companions : []` — validation runs first so a broken
    tree fails before burning N artifact builds. Log a `── <name> (i/n) ──`
    header so the step blocks are attributable.
13. **Fail fast** on the first failure: exit 1, naming what was published, what
    failed, and that later compositions were not attempted. Compositions in one
    invocation share a plugin union, so a second failure is almost always the
    same failure re-derived, and nothing published is lost.
14. Success: one summary listing each composition's `livePath → stagingPath`,
    plus build id and commit.

### `bin/commands/build.ts`

Add `--composition <name...>` and `--hermetic`; widen the `opts` type; insert the
branch as the action's first statement; change the single stage-1 call to
`compositions: []` and update the comment; replace the "`build` never builds a
composition… use `build-composition`" block. Everything from `ensureHooksPath`
down is untouched.

### `bin/cli.ts` + delete `bin/commands/build-composition.ts`

Drop the import and the `registerBuildComposition(program)` line.

### `bin/commands/release.ts` (~745)

```ts
["bun", join(root, "plugins/framework/plugins/cli/bin/index.ts"),
 "build", "--hermetic", "--composition", opts.composition]
```

Put `--hermetic` before `--composition` — commander's variadic is greedy to the
next flag. The long docblock above it stays substantively correct; rename the
command and note the enforcement is now process-level.

**One intentional behaviour delta to record there:** `build` is in
`OP_COMMANDS`, `build-composition` was not, and `bin/index.ts` calls
`isOpCommand(process.argv[2])` before parsing flags — so the hermetic child now
installs the orphan guard. Under `release` its ppid is release's, so the guard is
inert unless release itself dies, in which case exiting (and dropping
`.build.lock`) is the right behaviour. `build-composition`'s original
justification for staying out was the `bun --inspect` re-exec, removed
2026-07-28.

### `check/index.ts`

Replace `importSubsetCheck` and the `BUILD` / `BUILD_COMPOSITION` constants. Keep
`importClosure`, `aliasSpecifiers`, `resolvesWithoutNodeModules` and
`bootstrapPackageFreeCheck` — `importClosure` is the right instrument, pointed at
a better subject.

```ts
const CLI_ENTRY = "plugins/framework/plugins/cli/bin/index.ts";

const manifestFreezeCheck: Check = {
  id: "cli:codegen-manifests-not-frozen",
  description:
    "no module in the CLI process's import closure may reach a registered pre-barrel or " +
    "post-web codegen manifest — a manifest frozen at CLI load is regenerated on disk but " +
    "never re-read, and pruneOrphanedConfigFiles then deletes a freshly-authored override",
  alwaysRun: true,
  async run() {
    const root = await getWorktreeRoot();
    const hazards = new Map<string, string>();            // repo-relative path -> manifest id
    for (const m of [...preBarrelManifests, ...postWebManifests])
      hazards.set(relative(root, m.path(root)), m.id);
    if (hazards.size === 0) throw new Error(/* empty set is a broken read, never a pass */);
    const { modules } = await importClosure(root, CLI_ENTRY);
    const reached = [...hazards].filter(([rel]) => modules.has(rel)) /* … */;
    return reached.length === 0 ? { ok: true } : { ok: false, message, hint };
  },
};
```

- **Entry point `bin/index.ts`, dynamic edges followed** (the default). The
  subject is *the process*, and `index.ts`'s `await import("./cli")` is a literal
  specifier the bundler follows, so one entry covers both halves. ~95 ms.
- **`alwaysRun: true`** — cheap, structural, codegen-coupled, and decisively: the
  hermetic path runs stage 2 (and therefore `pruneOrphanedConfigFiles`) while
  running only the `alwaysRun` set. The old check was not `alwaysRun`; that was a
  gap.
- Importing `codegen/core` here adds nothing to the closure — it is already in it
  via `check.generated.ts` → `pre-barrel-manifests-complete/check`, and
  `pre-barrel-manifests.ts` imports the *generators*, not the generated files, so
  the check does not falsify itself.
- **Known limit to document:** following literal dynamic edges pulls in every
  check module, so a *check* importing a manifest would be flagged though it runs
  in stage 3. Conservative on purpose; the remedy is always cheap and
  independently right — read the file's bytes rather than `import` it. Also note
  in `importClosure`'s docblock that it reads the single emitted `.map`, which is
  complete only because `splitting` is off.

### `tooling/plugins/guards/core/guards/background-ops.ts`

Drop `"build-composition"` from `LONG_OPS`; `"build"` and `"release"` cover every
path.

### Prose sweep — no behaviour, easy to half-do

`cli/CLAUDE.md` (command table, the op-commands paragraph, the whole "artifact /
deploy seam" section, the subset-invariant bullet), `cli/bin/migrations.ts`
(18–19 names the retired check as its own rationale; 58, 246 are command lists),
`cli/bin/build-output.ts:62`, `internal/experimental-marker.ts:11`,
`internal/legacy-dist-reap.ts:36,50`, `web-artifacts/core/internal/compose.ts:42`
+ its CLAUDE.md, `infra/asset-mirror/server/internal/run-prewarm.ts:7`,
`infra/paths/core/internal/paths.ts:139`, `release/CLAUDE.md` +
`release/plugins/bundles/**`, `.gitignore`, and tick Phase 2 in the parent
research doc with the settled decisions.

`plugins/build/server/internal/run-build.ts:413` is the only other CLI spawner
(`build --allow-main` + optional `--serve-composition`) — unaffected.

## Verification

Ordered so each failure has one candidate cause.

**Static**
1. `./equin check cli:codegen-manifests-not-frozen` → green.
2. **Break it deliberately**: add `import … from "@plugins/framework/plugins/web-sdk/core/web-tiers.generated"`
   to `build.ts`, re-run, confirm it names `web-tiers.generated.ts (eagerTier)`. Revert.
   A check never seen failing is a check not known to work — and this one is the
   repo's only guard against silent config deletion.
3. `./equin check cli:bootstrap-package-free pre-barrel-manifests-complete plugins-registry-in-sync migrations-in-sync` → green.
4. `./equin check` full → green; old id gone from the roster, new id present.
5. `./equin --help` has no `build-composition`; `build --help` documents both flags.

**Flag surface** — each must exit 1 in under ~2 s (longer means the guard sits
downstream of `ensureDeps`): `--composition sonata` alone; `--hermetic` alone;
`--hermetic --composition singularity`; the four deploy-only flag combinations;
`--hermetic --composition sonata nosuchthing`. Plus
`./equin test plugins/framework/plugins/cli` for the
`hermeticFlagConflicts` matrix.

**Behavioural**
6. `build --hermetic --composition sonata` → same three outputs as
   `build-composition` did (`server.composition.sonata.generated.ts`,
   `web.composition.sonata.generated.ts`,
   `~/.singularity/worktrees/<checkout>/release-web/sonata`); diff the dist tree
   listing against a pre-change run.
7. **The exit-code contract, both halves** — the single most important test here.
   Missing `--migration-name` with a pending schema change ⇒ exit **1**. An
   ambiguous rename ⇒ stdout contains `MIGRATION_PROMPTS_DETECTED` and exit
   **2**, with no `BUILD FAILED` / `BUILD ABORTED` banner and no
   `build-status.json` rewrite.
8. `./equin release --composition sonata --target web` end to end.
9. **Variadic sharing**: `--composition sonata website` ⇒ one
   `Dependencies already up to date.`, one `Generating plugin registry…`, one
   `Generating DB migrations…`, one `checks (always-run)`; two closure lines; two
   dists; and the second's `web artifacts: A built, B reused` shows reuse
   dominating (target-model verification #2).
10. **Fail-fast**: break a plugin inside `website`'s closure only ⇒ sonata
    published, website fails, exit 1, message names both.
11. **Deploy path unchanged**: plain `./equin build` from this worktree;
    `build-profile-<id>.json`'s span id/phase/label set byte-identical to a
    pre-change build (this is why the `if` goes *inside* the
    `compositionRegistry` span).
12. **Orphan-guard delta**: start a hermetic build from a shell, kill the shell,
    confirm the child exits and `.build.lock` is immediately grantable.

## Flagged, not resolved here

- **Releasing the main app is now impossible** (`--composition singularity`
  refused). Correct under Phase 1's constraint, but a real capability gap Phase
  3/4 must reopen.
- **`compositionsConfig.fields.manifests.defaultValue` is the code seed, not the
  resolved layered config** — a user-layer `compositions.jsonc` addition is
  invisible to `--composition`. Unchanged from `build-composition`; the variadic
  form makes tripping it likelier. One sentence in the option description.
- **Registry-phase generated files are frozen in the CLI closure too**
  (`auto-stubs.generated.ts` et al.) — same mechanism, loud-or-benign failure
  mode rather than silent, so out of scope. Worth its own task.
- **`lane: "interactive"`** is inherited for `--hermetic`; Phase 6's scheduled
  composition builds will want to revisit.

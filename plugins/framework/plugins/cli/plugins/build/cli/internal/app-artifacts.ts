import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  generateCompositionRegistry,
  listNamedCompositionRegistries,
  regenerateManifestCodegen,
  regenerateRegistryCodegen,
  seedAuthoredOverrides,
  generateConfigGitLayer,
  type CodegenStep,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { repoProgram } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { spawnTypeCheckWorker } from "@plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/server";
import {
  admitThroughGate,
  mustRequeue,
  PROGRESS_FILE,
  readBuildProgress,
  runCheckSubprocess,
  type ValveDeps,
} from "@plugins/framework/plugins/cli/plugins/op-runtime/cli";
import {
  compositionFleetSource,
  runWebArtifactsPipeline,
} from "@plugins/framework/plugins/tooling/plugins/web-artifacts/core";
import { carryForwardServedEntries } from "@plugins/framework/plugins/tooling/plugins/web-artifacts/cli";
import { buildPluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import {
  flattenManifest,
  resolveComposition,
} from "@plugins/plugin-meta/plugins/closure/core";
import {
  compositionsConfig,
  manifestItemToManifest,
  type CompositionManifestItem,
} from "@plugins/plugin-meta/plugins/composition/core";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/server";
import { withHostGrant } from "@plugins/infra/plugins/host/plugins/host-admission/server";
import {
  cpuBudget,
  type Grant,
  type GrantHooks,
  type Lane,
  type Priority,
} from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { isUnderDuress } from "@plugins/infra/plugins/host/plugins/duress/plugins/latch/server";
import {
  acquireCheckoutLock,
  ensureDeps,
  type HolderObservation,
} from "@plugins/framework/plugins/cli/plugins/bootstrap/cli";
import {
  OP_LOG_FILE,
  readOpenWait,
} from "@plugins/debug/plugins/profiling/plugins/op-log/server";
import { buildHolderObservation } from "./build-holder";
import {
  generateMigration,
  type MigrationAnswer,
} from "@plugins/framework/plugins/cli/plugins/migrations/cli";
import { planCompositionSet } from "./composition-set";
import { distStagingPath, publishDistAtomic } from "./dist-publish";
import { stampExperimentalMarker } from "./experimental-marker";
import {
  MAIN_COMPOSITION_ID,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";

/**
 * Single source of truth for the ordered **app-artifact** pipeline: the part of
 * `./singularity build` that is a deterministic function of (source tree,
 * composition) — filesystem, CPU and network-for-deps only.
 *
 * `build`'s action conflates two jobs: *produce the artifact set* and *deploy it
 * into the live dev cluster*. Only the first is portable; the second needs a
 * provisioned dev box (embedded Postgres, a DB fork, the gateway, the run
 * ledger). Extracting job 1 here is what lets a second, process-isolated caller
 * (`build --hermetic`, which `release` shells into) cut an artifact on a bare
 * host from a fresh `git clone`, while `build` keeps its exact behaviour: it
 * calls these stages and gains ZERO new conditionals.
 *
 * This is the same shape as
 * `tooling/plugins/codegen/core/regen-pipeline.ts` — which solved the identical
 * problem one level down — including the reason it is split into THREE
 * functions rather than one: build's dev-only steps are *not* contiguous. They
 * interleave between the stages, and the boundaries below fall exactly where
 * nothing crosses:
 *
 *   stage 1  prepareCompositionSources  (deps + registry-level codegen)
 *   ----     build only: central routes manifest, central.json, waitForPg,
 *            waitForWorktreeDatabase, build_runs row mint
 *   stage 2  generateAppSources         (migrations + manifest-level codegen)
 *   ----     build only: propagateConfigToUser
 *   stage 3  buildAndPublishWebDist     (host grant, heavy jobs, atomic publish)
 *
 * Out of scope — deploy concerns, deliberately left in each caller:
 *   - `waitForPg` / `waitForWorktreeDatabase` — live cluster readiness.
 *   - the `build_runs` run-ledger (mint + close) and build-progress log.
 *   - every gateway HTTP call (`writeWorktreeSpec`, restart, health probes).
 *   - the worktree-op liveness marker (`markWorktreeOpStart`).
 *   - the per-namespace deploy sequence (`./deploy-namespace.ts`): the
 *     `composition.json` provenance marker, the database, the spec, the restart.
 *   - `propagateConfigToUser` — same function, different sink per caller (build
 *     targets `~/.singularity/state/config/<worktree>`, a release targets its own
 *     `config-seed`), so the sink IS the parameterization. Mirrors
 *     regen-pipeline.ts's own out-of-scope note.
 *   - `sweepDistLeftovers` — the caller sweeps its own dist dir right after
 *     `acquireArtifactLock`, before any staging dir is created.
 *   - build's step-log / profile / verdict writers. The module only *produces*
 *     `StepResult[]`; rendering and the failure wording stay in `run.ts`.
 *
 * ORDERING CONSTRAINTS (load-bearing — do not reorder):
 *   - dependencies FIRST (`ensureDeps`, stage 1): vite, drizzle-kit and tsc are
 *     all resolved out of `node_modules`, and a release additionally vendors the
 *     embedded-postgres / pgbouncer natives from there. Including it is what
 *     makes a fresh `git clone` work. Freshness-gated, so for a dev build —
 *     whose `./singularity` bootstrap just ran the same function — it collapses
 *     to a no-op instead of a second 10–25 s install.
 *   - registry codegen BEFORE the composition registry: the filtered
 *     per-composition registries are emitted beside the full committed ones the
 *     registry pass just regenerated.
 *   - stage 1 BEFORE central is spawned by the caller — `plugins.generated.ts`
 *     must be in sync — hence the split at the stage-1 boundary.
 *   - migrations BEFORE manifest codegen (stage 2's internal order): drizzle's
 *     generate is stateful and interleaved with the caller's DB steps, while
 *     `regenerateManifestCodegen` is pure repo-tree codegen.
 *   - `seedAuthoredOverrides` LAST in stage 2: it reads each config origin's
 *     hash + body off disk (written by the origins pass inside
 *     `regenerateManifestCodegen`) and must land before the caller propagates
 *     config, so the user layer never sees a half-seeded git layer. NB it mints
 *     `@review` markers into the checkout — today's behaviour for a release
 *     too, since a release reaches it through this same pipeline. Only the
 *     config git-layer bundle (`generateConfigGitLayer`) follows it: it reads
 *     the seeded tree and writes one layer per resident web registry, which
 *     stage 3 serves from each composition's registry artifact.
 *   - stage 3 LAST, under ONE host CPU grant covering every heavy child
 *     (checks, tsc, vite / web-artifacts). Nothing inside re-acquires host-wide.
 *
 * ESM-FREEZE CONSTRAINT (inherited from regen-pipeline.ts): Bun's ESM cache
 * freezes a module on its first `import()`, and a later disk write cannot
 * invalidate it. `regenerateManifestCodegen` (stage 2) regenerates every
 * barrel-reachable manifest and arms `setPreBarrelImportGuard` BEFORE the first
 * barrel import — which only works in a process that has not already imported a
 * plugin barrel. Otherwise `generateConfigOrigins` re-imports stale barrels and
 * `pruneOrphanedConfigFiles` deletes a freshly-authored override. The property
 * that has to hold is about the PROCESS, not about any one command file: no
 * module in the CLI process's import closure may reach a registered pre-barrel
 * or post-web codegen manifest, because such a manifest is frozen at CLI load,
 * regenerated on disk here, and never re-read — so the codegen that follows
 * reads the PREVIOUS run's descriptor set and prunes a config override that
 * exists. `assertPreBarrelManifestsFresh` cannot see this (it compares against
 * disk, which is fresh); the `cli:codegen-manifests-not-frozen` check is the
 * only mechanical guard, and it is `alwaysRun` because the hermetic path reaches
 * stage 2 while running only the always-run set. (This is also why `release.ts`,
 * which statically imports plugin barrels, must shell out to a separate process
 * rather than call this module in-process.)
 *
 * LOCK ORDERING (why there is no deadlock): the two locks a caller of this
 * module can hold are acquired in ONE direction only —
 *
 *     `.build.lock`  (acquireArtifactLock, held by the caller for its lifetime)
 *          ↓
 *     `.install.lock` (inside stage 1's `ensureDeps`, released before it returns)
 *
 * — and never the reverse: nothing anywhere acquires the build lock while
 * holding the install lock, so the two can never form a cycle. The install lock
 * is deliberately NOT `.build.lock` itself: sharing them would make a plain
 * `./singularity check` — which installs, but builds nothing — block for the
 * entire duration of a concurrent build in the same checkout.
 *
 * FAILURE IS A TYPE, not a value: stage 3 returns a discriminated
 * `ArtifactBuildResult` — on any failed step it `rm`s its own staging dir first,
 * so a failed artifact build never leaks one (relying on the next run's
 * `sweepDistLeftovers` would be silent cleanup). ONE DOCUMENTED process-exit
 * exception, pre-existing and preserved verbatim because callers depend on the
 * exit code:
 *   - `generateMigration` (stage 2) exits 1 on an invalid name and exits 2 when
 *     drizzle-kit shows rename/create prompts — `release` relies on that code.
 *
 * Stage 1's install used to be a second such exception (`exec` exited 1 on a
 * nonzero `bun install`). It is now `ensureDeps`, which THROWS a message naming
 * the failing phase — strictly better here: both callers route a thrown stage
 * into their own error path (`build`'s verdict guard + `finalizeBuild` still
 * render "aborted before completing", `runCli` sets exit 1), whereas the bare
 * `process.exit(1)` produced the same code with no explanation of which phase
 * died. No caller keys on install-specific exit behaviour.
 */

/**
 * Observability seam. `build` passes its real profiler + console; a hermetic
 * caller passes no-ops. Shaped to `buildProfilerStart` / `pushBuildSpan`
 * EXACTLY so build's spans stay byte-identical — every span id, phase and label
 * this module emits is therefore preserved by construction, not by copying.
 */
export interface ArtifactHooks {
  /** `buildProfilerStart` — opens a span; the returned closure closes it. */
  span: (
    id: string,
    phase: string,
    label: string,
  ) => (info?: { maxRssBytes?: number }) => void;
  /** `pushBuildSpan` — records an already-finished span retroactively. */
  pushSpan: (
    id: string,
    phase: string,
    label: string,
    durationMs: number,
    wallStartMs?: number,
  ) => void;
  log: (line: string) => void;
  /** Routes a phase's peak RSS into the caller's `maxRSS` line collector. */
  recordFootprint: (label: string, maxRssBytes: number | undefined) => void;
}

/** One step of the heavy section, run on the shared host CPU grant. */
export type HeavyJob = (grant: Grant) => Promise<StepResult>;

export interface StepResult {
  id: string;
  label: string;
  lines: Array<{ text: string; stream: "stdout" | "stderr" }>;
  durationMs: number;
  success: boolean;
}

/**
 * Returned from inside the host grant when the post-acquire duress re-check
 * fires: the heavy section did NOT run, and `withHostGrant`'s `finally` releases
 * the share on the way out — so the caller can release the gate and be admitted
 * again, alone. A `unique symbol` so it can never collide with a real `StepResult[]`.
 */
const REQUEUE = Symbol("requeue");

// One greppable line per measured build phase, e.g. "vite build: maxRSS 3.5 GB"
// (console + build.log). The calibration input for host-admission's per-holder
// footprint constants (@plugins/infra/plugins/host/plugins/host-admission/core PER_UNIT_BYTES)
// and any future per-build memory budget.
//
// Units are DECIMAL (1 GB = 1e9 B, 1 MB = 1e6 B) — deliberately, because
// PER_UNIT_BYTES is decimal (3.6e9). Dividing by 2**30 and labelling the result
// "GB" (as this did) understates the true byte count by ~7 %, which silently
// corrupts anyone calibrating the constant by reading these lines.
export function maxRssLine(
  label: string,
  maxRssBytes: number | undefined,
): string | null {
  if (maxRssBytes == null) return null;
  const gb = maxRssBytes / 1e9;
  const amount =
    gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(maxRssBytes / 1e6)} MB`;
  return `${label}: maxRSS ${amount}`;
}

/**
 * Per-step wrapper for the shared codegen pipeline: keeps the caller's per-step
 * profiler granularity while the ordered call list lives in codegen core (shared
 * with `regen-generated`). `pluginDocs` historically lived under the
 * `build:validation` phase; every other codegen step under `build:codegen` —
 * DERIVED here, from `hooks.span`, so the two callers cannot drift on it.
 */
function codegenStepFor(hooks: ArtifactHooks): CodegenStep {
  return async (id, label, run) => {
    const phase = id === "pluginDocs" ? "build:validation" : "build:codegen";
    const end = hooks.span(id, phase, label);
    try {
      await run();
    } finally {
      end();
    }
  };
}

/**
 * The per-checkout artifact lock. Serializes artifact production (codegen +
 * dist publish) against any other build/release in the same checkout — a plain
 * filesystem symlink, so it works on a bare host. Callers sweep their own dist
 * leftovers immediately after this returns.
 */
export async function acquireArtifactLock(webDir: string): Promise<void> {
  // `acquireCheckoutLock` resolves to a release closure; the lock is deliberately
  // held for the whole process lifetime (its own exit hook releases it), which
  // is exactly what build does today — so the closure is dropped here too.
  await acquireCheckoutLock(resolve(webDir, ".build.lock"), {
    what: "build",
    observeHolder: observeBuildHolder,
  });
}

/**
 * What the current lock holder is doing, for the lock's wait policy and its
 * "still waiting" lines — read from the two durable host-global logs a build
 * writes: build-progress (its steps, keyed by pid) and the op log (its declared
 * waits, keyed by build id).
 *
 * Passed IN rather than read by `checkout-lock` itself, because that module is
 * statically reachable from `bin/index.ts` and so loads before `bun install`;
 * both logs reach the file-sink primitive and a data-dir declaration, neither
 * of which the pre-install closure can afford. Here, deep inside a build, both
 * are already loaded.
 *
 * `unknown` when the holder has no live recorded run — a release's hermetic
 * build writes none — so the lock keeps its plain wait limit rather than
 * trusting a holder it cannot see.
 */
function observeBuildHolder(pid: number): HolderObservation {
  const run = readBuildProgress().find((r) => r.pid === pid && r.done === null);
  const openWait = run?.buildId == null ? null : readOpenWait(run.buildId);
  return buildHolderObservation(run, openWait, {
    progress: PROGRESS_FILE,
    opLog: OP_LOG_FILE,
  });
}

/**
 * Every id must name a manifest entry. Exported so a caller can reject a typo
 * in MILLISECONDS — before `ensureDeps`, i.e. before the run has spent anything
 * — instead of at the composition-registry step twenty minutes in. Throws ONCE
 * naming every unknown id plus the known set: a caller fixing two typos should
 * not have to run twice to find the second.
 *
 * The manifest list read here is the code seed
 * (`compositionsConfig.fields.manifests.defaultValue`), NOT the resolved layered
 * config — a composition a user added in their own `compositions.jsonc` is
 * therefore unknown to this path.
 */
export function assertKnownCompositions(ids: readonly string[]): void {
  const items = compositionsConfig.fields.manifests.defaultValue;
  const known = new Set(items.map((m) => m.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown composition${unknown.length > 1 ? "s" : ""} ${unknown
        .map((id) => `"${id}"`)
        .join(", ")}. Known: ${items.map((m) => m.id).join(", ")}`,
    );
  }
}

/**
 * Stage 1 — dependencies + registry-level repo-tree codegen + (when building
 * compositions) each composition's filtered registries.
 */
export async function prepareCompositionSources(opts: {
  root: string;
  /**
   * The manifest DOCUMENT `compositions` is resolved against, and the document
   * `extends` references resolve within. Supplied by the caller because the two
   * postures read genuinely different documents: the hermetic one reads the CODE
   * SEED (a release is cut from what the source tree declares), the deploy one
   * reads the checkout's RESOLVED config (a Studio-created composition exists
   * only in a user layer, and it must be servable). Stated at both call sites.
   */
  manifest: readonly CompositionManifestItem[];
  /**
   * The composition ids being built; `[]` emits no filtered registry at all.
   * Every id must name a row in `manifest`.
   */
  compositions: readonly string[];
  hooks: ArtifactHooks;
}): Promise<void> {
  const { root, compositions, hooks } = opts;
  const codegenStep = codegenStepFor(hooks);

  // 1. Install dependencies. Required before the gateway can find the
  // platform-specific embedded-postgres binaries under
  // plugins/infra/plugins/database/node_modules/@embedded-postgres/.
  //
  // Through `ensureDeps` — the repo's ONE install chokepoint (freshness-gated,
  // serialized on `.install.lock`, loud on failure), the same function the
  // `./singularity` bootstrap already ran moments ago. So for a dev build this
  // is normally a ~140 ms no-op reporting `installed: false`, and the old
  // double 10–25 s install per build (wrapper, then here) is gone. The call
  // stays because `build --hermetic` on a bare host from a fresh `git clone`
  // is the caller that genuinely needs the install, and stage 1 is where the
  // ordering constraint above puts it.
  //
  // `ensureDeps` OWNS every in-flight line of this phase (the lock-wait notice,
  // and the install child's passed-through output) — it is the only side that
  // knows an install is about to happen. This caller therefore announces
  // nothing up front and reports RETROSPECTIVELY, from `kind`: a
  // pre-emptive "Installing dependencies..." would be a plain false statement
  // on the normal fresh-skip path, and even on the install path it would land
  // after bun's own output, since the passthrough completes before the call
  // returns. Past tense for the same ordering reason.
  //
  // Neither non-`fresh` kind re-execs here, exactly as `installed` never did:
  // this caller is mid-build with the CLI already loaded (see
  // `EnsureDepsResult` for the constraint that places on it).
  let endSpan = hooks.span("bunInstall", "build:setup", "bun install");
  const deps = await ensureDeps({ root, log: hooks.log });
  hooks.log(
    {
      fresh: "Dependencies already up to date.",
      installed: "Installed dependencies.",
      "installed-by-other":
        "Dependencies were installed by another command in this checkout.",
    }[deps.kind],
  );
  // No footprint to report: the install usually does not RUN here (fresh-skip),
  // and when it does it is `ensureDeps`' own passthrough child, whose rusage it
  // does not surface. Both sinks take `number | undefined`, so pass `undefined`
  // — `maxRssLine` then prints nothing — rather than attributing a peak this
  // phase did not measure. The seam stays wired for the day it can measure again.
  endSpan({ maxRssBytes: undefined });
  hooks.recordFootprint("bun install", undefined);

  // 1b–2a. Registry-level repo-tree codegen: barrel-import auto-stubs (from
  // .d.ts files) then the plugin registry. Must happen before central is
  // spawned so its plugins.generated.ts is in sync. Shared with the push-time
  // `regen-generated` normalize step via the codegen core pipeline so a full
  // build after a push reproduces the exact same tree. Per-step profiler
  // spans are threaded through `onStep` so build keeps its granularity.
  hooks.log("Generating plugin registry...");
  const { renamedPackages } = await regenerateRegistryCodegen({
    root,
    onStep: codegenStep,
  });

  // 1b'. A plugin `package.json` whose derived `"name"` codegen just corrected
  // (a new or moved plugin) leaves `bun.lock` — which records every workspace
  // member's name — describing the old one, so the next frozen install (push)
  // would refuse it. Re-resolve now, while this build still owns the install:
  // `ensureDeps` sees the changed package.json and rewrites the lockfile.
  if (renamedPackages.length > 0) {
    hooks.log(
      `Wrote the derived package name in ${renamedPackages.length} package.json file(s):\n  ${renamedPackages.join("\n  ")}`,
    );
    await ensureDeps({ root, log: hooks.log });
  }

  // 2a'. Composition build-gating. For each named composition, emit gitignored
  // filtered registries (the bundle's hard closure) beside the committed
  // full ones, keyed by the composition NAME; the web/server import seams
  // select the filtered file by that name. The committed `<dir>.generated.ts`
  // files are never touched either way, so the build stays byte-identical.
  //
  // The set built is the composition ids NAMED by this build, plus every one
  // already RESIDENT in this checkout (see below) — a registry on disk is this
  // tree's registry, always, so no build leaves another composition's behind at
  // an older commit.
  //
  // The MAIN composition is filtered out of it, and that is not a carve-out: its
  // registry IS the committed one (`compositionRegistryFileName`), so
  // `generateCompositionRegistry` would return without writing anything anyway —
  // dropping it is what keeps a plain `./singularity build` in a checkout that
  // composes NOTHING from paying for the faceted plugin-tree walk below to
  // produce nothing. A checkout that does compose something pays the walk on
  // every build, which is the price of the registries it hosts being true.
  //
  // The span opens UNCONDITIONALLY, with the `if` inside it: `build`'s profile
  // is compared span-for-span across releases, so a plain build must keep
  // emitting `compositionRegistry` (empty) exactly as it did.
  endSpan = hooks.span(
    "compositionRegistry",
    "build:codegen",
    "composition registry",
  );
  const byId = new Map(opts.manifest.map((i) => [i.id, i]));
  const unknown = compositions.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown composition${unknown.length > 1 ? "s" : ""} ` +
        `${unknown.map((id) => `"${id}"`).join(", ")}. ` +
        `Known: ${opts.manifest.map((i) => i.id).join(", ")}`,
    );
  }
  // Every composition already RESIDENT in this checkout is regenerated too,
  // whether or not this build named it — `planCompositionSet` states why.
  const plan = planCompositionSet(
    compositions.filter((id) => id !== MAIN_COMPOSITION_ID),
    [...new Set(listNamedCompositionRegistries(root).map((r) => r.name))],
    (id) => byId.has(id),
  );
  for (const id of plan.unverifiable) {
    hooks.log(
      `Composition "${id}": registry resident in this checkout but absent ` +
        `from this build's manifest — left unregenerated (it may be stale).`,
    );
  }
  const filtered = plan.build;
  if (filtered.length > 0) {
    const allManifests = opts.manifest.map(manifestItemToManifest);
    // ONE tree walk for N compositions — the whole reason the list is variadic.
    // The walk is the expensive part (every plugin dir, faceted); resolving a
    // closure against an already-built tree is cheap.
    const tree = await buildPluginTree(join(root, "plugins"), {
      skipBarrelImport: true,
      facets: true,
    });
    for (const composition of filtered) {
      // Non-null: `plan.build` holds only ids `byId.has` accepted.
      const item = byId.get(composition)!;
      const flat = flattenManifest(manifestItemToManifest(item), allManifests);
      const bundle = resolveComposition(tree, flat).bundle;
      // All N registries land before stage 3 imports any of them —
      // `compositionFleetSource` does a per-file `import(registryFile)`, so a
      // registry written lazily per dist would be read for a composition whose
      // turn had not come.
      await generateCompositionRegistry({
        root,
        bundle,
        name: composition,
        home: item.home,
      });
      hooks.log(
        `Composition "${composition}": ${bundle.size} plugins in closure.`,
      );
    }
  }
  endSpan();
}

/**
 * Stage 2 — DB migration generation + manifest-level repo-tree codegen +
 * the mandatory-override seed.
 *
 * MAY TERMINATE THE PROCESS: `generateMigration` exits 1 on an invalid
 * `--migration-name` and exits 2 when drizzle-kit shows rename/create prompts
 * (printing the structured prompt JSON). That contract is unchanged and
 * `release` depends on the exit code — see the module docblock.
 */
export async function generateAppSources(opts: {
  root: string;
  migration: {
    name?: string;
    reset?: boolean;
    custom?: boolean;
    answers?: MigrationAnswer[];
  };
  hooks: ArtifactHooks;
}): Promise<void> {
  const { root, hooks } = opts;
  const codegenStep = codegenStepFor(hooks);

  // 3. Regenerate DB migrations from plugin schema files
  let endSpan = hooks.span(
    "generateMigration",
    "build:database",
    "generate migrations",
  );
  hooks.log("Generating DB migrations...");
  const migration = await generateMigration({
    root,
    migrationName: opts.migration.name,
    resetMigration: opts.migration.reset,
    customMigration: opts.migration.custom,
    migrationAnswers: opts.migration.answers,
  });
  endSpan({ maxRssBytes: migration.maxRssBytes });
  hooks.recordFootprint("drizzle generate", migration.maxRssBytes);

  // 4–4b. Manifest-level repo-tree codegen: plugin docs → reorderable-slots
  // → data-views → token-group-vars → config-origins. Run AFTER migrations
  // (DB-stateful, interleaved by the caller) but as ONE ordered pipeline shared
  // with the push-time `regen-generated` normalize step (codegen core), so a
  // full build after a push reproduces the exact same tree. The load-bearing
  // ordering constraints (docs first → reusable enriched tree; slots/views
  // before origins → they register the config_v2 directives origins depend
  // on; token-group-vars before the CSS single-owner checks; origins LAST)
  // live in the pipeline module as the authoritative record. Per-step
  // profiler spans are threaded through `onStep`.
  hooks.log("Generating plugins doc...");
  await regenerateManifestCodegen({ root, onStep: codegenStep });

  // 4b'. Seed / re-mark the MANDATORY config overrides (descriptors that set
  // `requiresAuthoredOverride`). Runs after the origin pass above (it reads
  // each origin's hash + body off disk) and before propagation, so the user
  // layer never sees a half-seeded git layer. Deliberately NOT part of the
  // shared repo-tree codegen pipeline: it mints `@review` markers, and that
  // pipeline also runs from `regen-generated` inside push's amend path — see
  // regen-pipeline.ts.
  endSpan = hooks.span(
    "seedAuthoredOverrides",
    "build:codegen",
    "seed authored config overrides",
  );
  const seedResult = await seedAuthoredOverrides({ root });
  endSpan();
  for (const rel of seedResult.seeded) {
    hooks.log(
      `[config-v2] seeded required override config/${rel} (marked @review)`,
    );
  }
  for (const rel of seedResult.remarked) {
    hooks.log(
      `[config-v2] re-marked stale override config/${rel} (marked @review)`,
    );
  }

  // 4b''. Bundle the committed config layer for the browser server (a demo
  // scope answers `config-v2.values` from it, never from the host), once per
  // composition registry stage 1 left resident, each restricted to that
  // composition's plugins and apps. After the seeder, so it reads the same git
  // layer the caller then propagates; before stage 3, which serves each one
  // from its composition's registry artifact (`@composition-config-layer`).
  endSpan = hooks.span(
    "configGitLayer",
    "build:codegen",
    "bundle the committed config layer",
  );
  await generateConfigGitLayer({ root });
  endSpan();
}

/**
 * The `--skip-checks` validation set, shared by both callers so neither can
 * drift on what a fast artifact build still proves.
 *
 * Cheap, structural checks opt into running even on the fast path, so
 * codegen-coupled obligations — e.g. a newly-reorderable slot that still owes an
 * authored override — fail at build instead of slipping silently to `push`.
 * Selected generically via the `alwaysRun` flag (never by naming a check).
 * Plus one incremental tsc over the repo's ONE TypeScript program, since the
 * full `type-check` check (which covers it) did not run. It used to be one tsc
 * per runtime entrypoint (server-core, central-core, cli) because there was a
 * program per runtime; there is one program now, so there is one job.
 *
 * The check selection is NOT read here. It used to be — this function called
 * `listAllChecks()` and handed the resulting id list to `runChecks` — which was
 * a registry read performed in whichever process happened to be building, i.e.
 * the same contamination the spawned pass exists to escape, one level up. The
 * selection now travels as the `alwaysRun` flag and is resolved by the child,
 * which is also the only place that can notice it came out empty.
 */
export async function fastValidationJobs(opts: {
  root: string;
  /**
   * The run these checks belong to. Adopted by the spawned check pass, which
   * derives `check-<runId>.log` from it — the caller does not spell a path, and
   * cannot: the child resolves the worktree from its own `cwd`, so both sides
   * name the same file by construction rather than by agreement.
   */
  checkRunId: string;
  hooks: ArtifactHooks;
}): Promise<HeavyJob[]> {
  const { root, checkRunId, hooks } = opts;
  const jobs: HeavyJob[] = [];

  // Spawned, never called in-process — see ../../check-subprocess.ts. The
  // selection is the `alwaysRun` FLAG, resolved in the child against its own
  // freshly-loaded registry; no id list crosses the boundary. An empty selection
  // (the last `alwaysRun: true` deleted) fails loudly there, which is the only
  // place it can be noticed now that nothing here enumerates the set.
  //
  // The scopes are named alongside it (they compose as an AND) for the same
  // reason the full pass names them: this is still a BUILD asserting the
  // verdict, and a build cannot assert `host`. Belt to the braces of the
  // load-time refusal of an `alwaysRun` host check — this states what the pass
  // claims, that states that the contradiction cannot be written.
  jobs.push(async (grant) => {
    const start = performance.now();
    const result = await runCheckSubprocess({
      root,
      grant,
      select: { scope: ["tree", "deploy"], alwaysRun: true },
      runId: checkRunId,
      output: "capture",
    });
    for (const span of result.spans) {
      hooks.pushSpan(
        `check:${span.checkId}`,
        "build:checks",
        span.checkId,
        span.durationMs,
        span.wallStartMs,
      );
    }
    hooks.recordFootprint("checks (always-run)", result.maxRssBytes);
    return {
      // `id: "checks"` is load-bearing — build's failure funnel keys on it.
      id: "checks",
      label: "checks (always-run)",
      lines: result.lines,
      durationMs: Math.round(performance.now() - start),
      success: result.ok,
    };
  });

  const program = repoProgram(root);

  jobs.push(async (grant) => {
    const end = hooks.span(
      `tsc:${program.name}`,
      "build:validation",
      `tsc ${program.name}`,
    );
    const start = performance.now();
    const lines: StepResult["lines"] = [];
    // The SAME worker the `type-check` check runs — not a `tsc --noEmit` of
    // our own — so the compiler options, the declaration emit that gives every
    // checked file a real signature (the hash of its public shape), and the
    // two-program check that re-checks only the files whose key moved are
    // written down in one place. It reads and writes the same host-wide
    // name-records store as the check, so this path and the check never
    // re-check what the other already checked.
    //
    // Admitted exactly like the check's worker — the host-wide
    // `type-check-worker` slot in the grant's lane, then the measured grant
    // weight, the worker in the foreground as the slot's holder — because
    // `spawnTypeCheckWorker` is the one place a worker is admitted and takes
    // the grant itself.
    const run = await spawnTypeCheckWorker({
      root,
      name: program.name,
      tsconfigPath: program.tsconfigPath,
      tscMode: "keyed",
      // A missed prediction answers from one whole program and is reported,
      // never a failed build (`type-check`'s `shared/name-run.ts`).
      onMiss: "whole",
      // Type-checking only: linting belongs to the check pass this path is
      // skipping, and an empty list is what the worker reads as "none".
      lintFiles: [],
      grant,
    });
    end({ maxRssBytes: run.maxRssBytes });
    for (const line of run.result.tscErrors.split("\n")) {
      if (line) lines.push({ text: line, stream: "stdout" });
    }
    // A worker that CRASHED threw out of `spawnTypeCheckWorker` above and
    // takes this step down with it.
    const success = run.result.tscErrors === "";
    for (const text of run.result.tscLines)
      lines.push({ text, stream: "stdout" });
    const rss = maxRssLine(`tsc ${program.name}`, run.maxRssBytes);
    if (rss) lines.push({ text: rss, stream: "stdout" });
    return {
      id: `tsc:${program.name}`,
      label: `tsc ${program.name}`,
      lines,
      durationMs: Math.round(performance.now() - start),
      success,
    };
  });

  return jobs;
}

export type ArtifactBuildResult =
  | {
      ok: true;
      steps: StepResult[];
      /** The staging dir, already renamed into the published release. */
      stagingPath: string;
      /**
       * The published dist for `opts.target` — the live symlink now resolving
       * to the fresh release. Equal to `webDistPath(opts.target)`.
       */
      livePath: string;
      /**
       * The commit this build answered for (`opts.headAtStart`), echoed back for
       * the callers that report it; `""` when git could not answer.
       */
      buildCommit: string;
      /**
       * Content identity of the published web graph, stamped into the dist as
       * `.build-graph`. Unlike `buildId` it is a function of the bytes, so an
       * unchanged tree republishes the same value.
       */
      graphHash: string;
    }
  | { ok: false; steps: StepResult[]; failedLabels: string[] };

/**
 * WHICH dist this build produces — an IDENTITY, never a path. The path module
 * (`worktreeArtifacts`) owns the layout; a caller names what it is building and
 * gets the one location that identity maps to, so no two producers can be
 * pointed at the same tree by two independent path expressions. That is exactly
 * how a `release` came to publish over the checkout's live served dist.
 */
/**
 * A release's scratch dist — copied into a shippable bundle and served by
 * nobody. Keyed by *(the worktree that BUILT it, composition)*: a release has
 * no namespace of its own, and keying by the building checkout is what makes
 * the existing per-checkout `.build.lock` sufficient to serialize it.
 *
 * Named rather than left inline in the union below because the hermetic posture
 * holds a LIST of these and reads `.composition` off each one: against the bare
 * union that read does not narrow, and the alternative — re-narrowing per access
 * — would be a type dance around a set whose arm is known at construction.
 */
export interface ReleaseDistTarget {
  kind: "release";
  worktree: string;
  composition: string;
}

export type WebDistTarget =
  /**
   * The dist the gateway SERVES at `<name>.localhost:9000`. `name` is a
   * *namespace*: a worktree slug or an auto-served composition id. Published
   * atomically because a live reader exists.
   */
  { kind: "served"; name: Namespace } | ReleaseDistTarget;

/**
 * The ONE mapping from a dist identity to its live path. Exported because a
 * caller must sweep its own dist dir's leftovers (`sweepDistLeftovers`) before
 * stage 3 creates a staging dir — and sweeping a *different* path than the one
 * about to be published is precisely the drift this seam exists to prevent, so
 * the caller resolves its `target` through here rather than spelling a path.
 *
 * Both arms live under `~/.singularity/worktrees/`: no dist is written into a
 * checkout any more, so a checkout carries no build output and the served tree
 * survives operations on the checkout (a `git clean`, a worktree re-checkout).
 * It takes no checkout path at all — a build's `webDir` is the `.build.lock`'s
 * home and nothing else.
 */
export function webDistPath(target: WebDistTarget): string {
  return target.kind === "release"
    ? worktreeArtifacts.releaseWebDist(target.worktree, target.composition)
    : worktreeArtifacts.webDist(target.name);
}

/** How the heavy section is admitted: the duress gate, then the host grant. */
export interface HeavyAdmission {
  gated: boolean;
  deps: ValveDeps;
  grantHooks?: GrantHooks;
  /**
   * Fires each time duress tripped while a calm-admitted build queued for its
   * grant, and grant and gate were released to be admitted again (alone);
   * `cycle` is the 1-based requeue count. The op log records it so every later
   * wait carries its cycle.
   */
  onRequeue?: (cycle: number) => void;
}

export interface BuildWebDistOptions {
  root: string;
  /**
   * The web-core dir, used for ONE thing: the `.build.lock` beside it
   * (`acquireArtifactLock`). The lock is per-checkout by necessity — it guards
   * the registry codegen this pipeline writes *into* the checkout — which is a
   * different question from where the dist lands. The dist location comes from
   * `target` alone; do not re-conflate the two.
   */
  webDir: string;
  /** WHICH dist to publish. Derives `livePath`; see {@link WebDistTarget}. */
  target: WebDistTarget;
  buildId: string;
  /**
   * The commit this build ANSWERS FOR — the caller's own sample, taken before
   * it read a single source file. It is what gets stamped into the dist as
   * `.build-commit`, and the caller has to supply it because only the caller
   * knows when its reads began: sampling `HEAD` here, after the compile, records
   * whatever the checkout moved to meanwhile rather than the tree these bytes
   * came from. `null` when git could not answer, which is written as no pin at
   * all — an unknown commit must not read as a commit.
   */
  headAtStart: string | null;
  composition: string | null;
  minify: boolean;
  /**
   * Copy each artifact out of the shared content-addressed store instead of
   * symlinking it, so the produced dist is SELF-CONTAINED. Only the release
   * path (`build --hermetic`) wants this: its dist is `cpSync`'d into a
   * shippable bundle, and symlinks into `~/.singularity/cache/web-artifacts/`
   * would
   * ship as dangling links on any other machine.
   *
   * Materializing HERE rather than dereferencing at the copy site is deliberate:
   * the release dist is written in release phase 1 (a `build --hermetic` child
   * process, which releases `.build.lock` when it exits) and read in phase 3, so
   * in that unlocked window a concurrent build's store pruning can dangle the
   * links — a `cpSync({ dereference: true })` in phase 3 would then fail or ship
   * a hole. A materialized dist has no window: it never referenced the store.
   */
  materialize: boolean;
  /**
   * Stamp the served `index.html` as an experimental (agent-worktree) deploy —
   * the red frame. Only `./singularity build` from a non-main worktree says
   * true; every other producer of a dist is clean. See ./experimental-marker.ts.
   */
  experimental: boolean;
  lane: Lane;
  /**
   * The host grant's admission priority — `low` for a sidequest checkout, so the
   * build takes a slot only while no main-track op is waiting (op-runtime's
   * `opPriority`).
   */
  priority: Priority;
  /** Demote heavy children (tsc, vite) to the background scheduling class. */
  background: boolean;
  /**
   * Heavy jobs that share this section's ONE host grant but are not artifact
   * production — validation. Started BEFORE the frontend job, in order, exactly
   * as build's own array did.
   */
  companions: HeavyJob[];
  admission: HeavyAdmission;
  /**
   * Fires the instant the heavy section completes — BEFORE the failure check
   * and before anything is published — with the same array the result carries.
   * Exists so a caller's transcript ordering (step blocks, step log) is
   * independent of what this function does afterwards.
   */
  onSteps?: (steps: StepResult[]) => void;
  hooks: ArtifactHooks;
}

/**
 * Stage 3 — the heavy section under ONE host CPU grant, then the atomic dist
 * publish.
 *
 * Validation (`companions`) and the frontend build are independent: checks read
 * source files, the frontend compiles into a staging dir. On failure the staging
 * dir is removed here and nothing is published, so a failed artifact build never
 * leaks one.
 */
export async function buildAndPublishWebDist(
  opts: BuildWebDistOptions,
): Promise<ArtifactBuildResult> {
  // `opts.webDir` is deliberately NOT destructured: since S4 the dist location
  // comes from `opts.target` alone, and this body has no use for the checkout
  // path. It survives on the options object as the `.build.lock`'s home, which
  // `acquireArtifactLock` — a caller's concern, not this function's — consumes.
  const { root, buildId, composition, companions, hooks } = opts;

  const livePath = webDistPath(opts.target);
  const stagingPath = distStagingPath(livePath);

  hooks.log(
    "Running checks, type-checking, and building frontend in parallel...",
  );

  // The composed graph's content hash, produced by the pipeline inside the heavy
  // job below and needed by the publish code after it. A `let` rather than a
  // return value because the job's shape is `StepResult` — the transcript row —
  // and the pin is not part of that.
  let graphHash: string | null = null;

  const webArtifactsJob: HeavyJob = async (grant) => {
    // Per-plugin artifact pipeline, in-process, into a staging dir the
    // atomic publish below then swaps in.
    // Grant-gated like the vite build it replaced: the pipeline's
    // internal fan-out (per-plugin vite builds on a cold store) is the
    // same class of heavy work, so it spends a unit of the build's CPU
    // budget rather than running on top of it.
    const end = hooks.span("viteBuild", "build:frontend", "web artifacts");
    const start = performance.now();
    const lines: StepResult["lines"] = [];
    let success = true;
    try {
      // WHAT the fleet is planned from. Without a composition the pipeline
      // defaults to the committed FULL registry; with one it MUST be told, or
      // it composes a green bundle containing every plugin in the repo instead
      // of the composition's closure — a silently wrong artifact, not a build
      // failure. The per-name `web.composition.<name>.generated.ts` this reads
      // was emitted by stage 1 moments ago.
      //
      // `vendors` is deliberately NOT passed. The old compose-serve stage
      // reused MAIN's full-fleet vendor set via `readFleetVendorMeta`, and
      // copying that here is the obvious wrong optimization: it THROWS unless
      // the full non-composition fleet is already in this host's artifact store
      // — which a hermetic release host (fresh `git clone`, cold store) does not
      // have, and neither does a worktree that has never built main. That throw
      // is exactly the main-first coupling the serve fan-out exists to remove.
      // Omitted, the pipeline resolves the vendor set from this fleet's own
      // requests — correct on any host.
      const source = composition
        ? await compositionFleetSource({ root, name: composition })
        : undefined;
      const result = await grant.run(() =>
        runWebArtifactsPipeline({
          root,
          stagingDir: stagingPath,
          minify: opts.minify,
          buildId,
          buildCommit: opts.headAtStart,
          source,
          materialize: opts.materialize,
          log: (line) => lines.push({ text: line, stream: "stdout" }),
          onStage: async (id, label, run) => {
            const endStage = hooks.span(id, "build:frontend", label);
            try {
              return await run();
            } finally {
              endStage();
            }
          },
        }),
      );
      graphHash = result.graphHash;
      lines.push({
        text:
          `web artifacts: ${result.builtArtifacts} built, ${result.reusedArtifacts} reused ` +
          `(${result.webArtifacts} web + ${result.coreArtifacts} core), ` +
          `${result.vendorSpecs} vendors, ${result.preloads} preloads`,
        stream: "stdout",
      });
    } catch (err) {
      success = false;
      const message =
        err instanceof Error ? (err.stack ?? err.message) : String(err);
      for (const line of message.split("\n")) {
        lines.push({ text: line, stream: "stderr" });
      }
    }
    end();
    return {
      id: "viteBuild",
      label: "web artifacts",
      lines,
      durationMs: Math.round(performance.now() - start),
      success,
    };
  };

  // The heavy section itself: everything the host CPU grant covers (checks +
  // tsc + the artifact fleet), running on the grant it is handed. Extracted so
  // the acquire around it can be a retry loop (below) without the body moving.
  //
  // buildId identifies the RUN (the build_runs row, the log files, the profile)
  // and is written to dist/.build-id below. It is deliberately not in the bundle
  // any more: what a tab needs to know is whether the bytes it is running are
  // still the bytes being served, which is `.build-graph`, not which run last
  // produced them.
  const runHeavySection = async (grant: Grant): Promise<StepResult[]> => {
    const parallel: Array<Promise<StepResult>> = [];
    for (const job of companions) parallel.push(job(grant));
    parallel.push(webArtifactsJob(grant));
    return await Promise.all(parallel);
  };

  // Gate this heavy section (eslint + tsc + vite) behind a host CPU GRANT so
  // concurrent builds across worktrees don't thrash the machine. A main build
  // takes the interactive lane (its reserved floor is unreachable by agent
  // work, so it's never blocked by agent builds); an agent build takes the
  // background lane. The grant's `units` are subdivided across everything the
  // build fans out into (type-check workers, tsc, vite) — nothing re-acquires
  // host-wide. See @plugins/infra/plugins/host-admission.
  //
  // Duress gate: a background-lane (agent) build takes the host-wide agent-build
  // gate BEFORE it queues for the grant — shared while the host is calm, alone
  // (exclusive, in arrival order) while the duress latch is fresh, so a box in
  // trouble runs one agent build at a time and the line always moves. No
  // timeout. Interactive (main), push, and the detached auto-build are not
  // gated. See op-runtime's admission-valve.ts and
  // research/2026-10-21-cli-duress-admission-one-at-a-time-v2.md.
  //
  // Gate first, grant second: a build waiting at the gate holds no CPU slots,
  // and a gate holder's only wait is for a grant, whose holders always finish.
  // A build admitted SHARED can still sit in the grant queue while duress
  // trips, and must not then start beside the others — so the re-check runs
  // INSIDE the grant, the moment the slots are held. On a hit the closure
  // returns REQUEUE, `withHostGrant`'s `finally` releases the share, the gate is
  // released, and the build is admitted again — exclusively this time, which
  // `mustRequeue` never re-checks, so the loop terminates. The gate is taken
  // per heavy section (per target), never across targets: holding it while
  // queuing for a second grant could deadlock against builds waiting for it.
  const acquireAndRunHeavySection = async (): Promise<StepResult[]> => {
    // Profile the full admission wait (gate holds + grant queueing, across
    // requeues) — without a span this wait is an unexplained hole in the
    // build Gantt (a contended build once sat here ~5 min, unattributed).
    // The op record splits what this single span necessarily merges: one
    // `host-grant` wait per requeue cycle, each distinct from the gate's.
    const endGrantWait = hooks.span(
      "acquireHostGrant",
      "build:setup",
      "wait for host CPU grant",
    );
    for (let cycle = 0; ;) {
      const gate = await admitThroughGate(
        { gated: opts.admission.gated },
        opts.admission.deps,
      );
      let result: StepResult[] | typeof REQUEUE;
      try {
        result = await withHostGrant<StepResult[] | typeof REQUEUE>(
          {
            lane: opts.lane,
            priority: opts.priority,
            max: cpuBudget().B,
            hooks: opts.admission.grantHooks,
          },
          async (grant) => {
            if (mustRequeue(gate, isUnderDuress())) return REQUEUE;
            endGrantWait();
            return await runHeavySection(grant);
          },
        );
      } finally {
        await gate?.release();
      }
      if (result !== REQUEUE) return result;
      cycle++;
      opts.admission.onRequeue?.(cycle);
      hooks.log(
        `build admission: duress tripped while queued for the host grant — ` +
          `released the grant, waiting to run alone (requeue #${cycle})...`,
      );
    }
  };

  const steps = await acquireAndRunHeavySection();
  opts.onSteps?.(steps);

  const failedLabels = steps.filter((r) => !r.success).map((r) => r.label);
  if (failedLabels.length > 0) {
    await rm(stagingPath, { recursive: true, force: true });
    return { ok: false, steps, failedLabels };
  }

  // The two pins that describe what was just built, so a server can say what it
  // is serving.
  //
  // The commit is the caller's PRE-BUILD sample, not a fresh `git rev-parse`
  // here: a checkout that moves mid-build (a `push` merging into main while this
  // runs) would otherwise stamp the dist with a commit whose code is not in it —
  // the exact reading that once made a stale frontend look current and cost a
  // catch-up build. Missing means unknown, so no file is written at all.
  const buildCommit = opts.headAtStart ?? "";
  if (buildCommit) {
    writeFileSync(resolve(stagingPath, ".build-commit"), buildCommit + "\n");
  }

  // The graph's content identity — what a tab compares itself against. Always
  // present on a successful build (the pipeline composed a graph to get here).
  if (graphHash === null) {
    throw new Error(
      "buildAndPublishWebDist: the artifact pipeline reported success without a graph hash",
    );
  }
  writeFileSync(resolve(stagingPath, ".build-graph"), graphHash + "\n");

  // The run that produced this dist — build_runs / logs / profile, not identity.
  writeFileSync(resolve(stagingPath, ".build-id"), buildId + "\n");

  // The experimental frame, stamped into the staged index.html by the producer
  // that knows this is an agent-worktree deploy — not guessed from the hostname
  // by the browser, which cannot tell a worktree namespace from a composition
  // or a release preview.
  if (opts.experimental) stampExperimentalMarker(stagingPath);

  // A tab loaded from an earlier build still fetches THAT build's addresses
  // (lazily — the deferred plugin tier, fonts), so a served dist keeps every
  // address the live one serves while the shared cache still holds it. Must run
  // before the swap: `livePath` still resolves to the previous release here. A
  // release is served by nobody and never carries.
  if (opts.target.kind === "served") {
    const carried = carryForwardServedEntries({
      liveDir: livePath,
      stagingDir: stagingPath,
    });
    hooks.log(
      `Carried forward from the previous dist: ${carried.artifactsCarried.length} artifacts, ` +
        `${carried.assetsCarried.length} assets (${carried.artifactsDropped.length} dropped, pruned from the cache)`,
    );
  }

  // Gapless publish via a `dist` → `dist.live.<pid>` symlink swap — see
  // ./dist-publish.ts for the mechanics (this supersedes the earlier
  // move-aside scheme, which left a real gap between two renames).
  const endPublish = hooks.span(
    "atomicPublish",
    "build:frontend",
    "atomic publish",
  );
  await publishDistAtomic({ dir: livePath, stagingPath });
  endPublish();

  return { ok: true, steps, stagingPath, livePath, buildCommit, graphHash };
}

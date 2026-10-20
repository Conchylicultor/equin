import { resolve } from "node:path";
import { markBuildInProgress } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  WEB_CORE_RELATIVE,
  checkoutNamespace,
  checkoutWorktreeName,
} from "@plugins/infra/plugins/paths/server";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  createValveDeps,
  printStepBlocks,
} from "@plugins/framework/plugins/cli/plugins/op-runtime/cli";
import { type MigrationAnswer } from "@plugins/framework/plugins/cli/plugins/migrations/cli";
import {
  acquireArtifactLock,
  assertKnownCompositions,
  buildAndPublishWebDist,
  fastValidationJobs,
  generateAppSources,
  maxRssLine,
  prepareCompositionSources,
  webDistPath,
  type ArtifactHooks,
  type ReleaseDistTarget,
} from "./app-artifacts";
import { compositionsConfig } from "@plugins/plugin-meta/plugins/composition/core";
import { sweepDistLeftovers } from "./dist-publish";
import { reapLegacyCheckoutDist } from "./legacy-dist-reap";

/**
 * The HERMETIC posture of `./singularity build` (`--hermetic --composition …`):
 * produce the app-artifact set for one or more compositions — filtered
 * registries, generated migration SQL, one web dist each — as a deterministic
 * function of (source tree, composition). Nothing here reads or mutates the
 * local dev cluster, so a release can be cut on a bare host from a fresh
 * `git clone`.
 *
 * A thin ordered stage sequence over a shared pipeline, exactly like
 * `regen-generated` is over `codegen/core/regen-pipeline.ts`: every step lives
 * in ./app-artifacts.ts, which the deploy posture also calls, so the two cannot
 * drift. Design + rationale:
 * research/2026-07-28-cli-hermetic-artifact-phase.md and
 * research/2026-08-18-cli-one-build-verb-artifact-half.md.
 *
 * Deliberately ABSENT — this list IS the definition of what `--hermetic` turns
 * off, because the deploy those steps serve does not exist here:
 *   - the branch guard and therefore `--allow-main` (routinising a DANGER flag
 *     on every release from main erodes it; dropping it is a net improvement),
 *   - `--no-restart` / `--skip-checks` (nothing to restart; the fast validation
 *     set is unconditional),
 *   - `ensureHooksPath` / `registerMergeDrivers` / `checkBroadcasts` — git-config
 *     self-heals and an agent-facing message channel, both dev-workstation
 *     concerns nobody watches on a release host,
 *   - Postgres readiness, the worktree DB fork, gateway specs/restarts/health
 *     probes, the per-namespace deploy sequence,
 *   - the `build_runs` ledger, worktree-op markers, the build-progress log, the
 *     build profile and the verdict guard. A release already has its own durable
 *     record — the supervised-run transcript its child writes; emitting build
 *     records for a run that is not a build is what polluted the build Gantt.
 * Consequently `hooks` below are light: `log` still reaches the console (the
 * release streams this process's stdout as its progress), but no span, footprint
 * or step is persisted anywhere.
 *
 * Those absences are why this is a SEPARATE FUNCTION rather than ~20 scattered
 * `if (!opts.hermetic)` guards inside `build`'s action. `build` arms, in its
 * first few hundred lines and interleaved with real work, `openBuildProgress`,
 * `createOpProfiler`, `createBuildRunRecorder`, `markWorktreeOpStart`, a
 * `process.on("exit")` hook, `installVerdictGuard`, `installFatalSignalExit` and
 * `writeBuildReceipt` — and the exit-code contract below is precisely the claim
 * that NONE of them is armed. Inline, that claim survives only as long as
 * nobody adds the 21st exit hook without its guard; branch-once-and-delegate
 * makes it structural, because this path never enters the function that arms
 * them.
 *
 * The orphan guard is the one piece of op-command machinery this path DOES get.
 * `bin/index.ts` arms it for every invocation, so a hermetic child is guarded by
 * construction — it used to depend on `build` being in an `OP_COMMANDS` set that
 * `bin/index.ts` matched against `process.argv[2]`, which happened to hold
 * because `build --hermetic` still has `build` at argv[2]. Under `release` this
 * child's ppid is release's own pid, so the guard is inert unless release itself
 * dies — in which case exiting, and thereby dropping `.build.lock`, is the right
 * behaviour.
 */

/**
 * Deploy-only flags plus the phase-scoped refusals, as data: one message per
 * conflict, `[]` when the invocation is coherent. Pure and exported so the
 * matrix is testable without building anything — the refusals have to fire in
 * milliseconds (before `ensureDeps`), and a guard that is only exercised by a
 * 10-minute build is a guard nobody re-runs.
 */
export function hermeticFlagConflicts(opts: {
  composition?: string[];
  allowMain?: boolean;
  skipChecks?: boolean;
  restart: boolean;
}): string[] {
  const conflicts: string[] = [];

  if (!opts.composition || opts.composition.length === 0) {
    conflicts.push(
      "--hermetic needs at least one --composition <name>: the dist it publishes is keyed by " +
        "(checkout, composition), so there is no dist to name without one.",
    );
  }

  // The three deploy-only flags. Each is inert on this path, and a silently-inert
  // flag is worse than a refused one: `--skip-checks` in particular would read
  // as "I skipped validation" when the hermetic path runs the fast validation
  // set unconditionally.
  if (opts.allowMain) {
    conflicts.push(
      "--allow-main is deploy-only: --hermetic has no branch guard to defeat (it never deploys), " +
        "so a release from main needs no override.",
    );
  }
  if (opts.skipChecks) {
    conflicts.push(
      "--skip-checks is deploy-only: --hermetic already runs exactly the fast validation set " +
        "(always-run checks + one incremental tsc per runtime entrypoint), unconditionally, and " +
        "has no full checks pass to skip.",
    );
  }
  if (opts.restart === false) {
    conflicts.push(
      "--no-restart is deploy-only: --hermetic contacts no gateway and starts no backend, so " +
        "there is nothing to restart.",
    );
  }
  return conflicts;
}

/**
 * The ordered hermetic stage sequence. Terminates the process on failure (and,
 * through stage 2, on a migration prompt) rather than returning a result: it is
 * a command body, and `release` keys on the exit code.
 */
export async function runHermeticBuild(opts: {
  compositions: readonly string[];
  migration: {
    name?: string;
    reset?: boolean;
    custom?: boolean;
    answers?: MigrationAnswer[];
  };
  minify: boolean;
}): Promise<void> {
  // Mark this process as a build: dist-comparing checks (map-in-sync) skip
  // while the dist they'd inspect is the one this run replaces. True for an
  // artifact-only run too — it rewrites exactly that dist.
  markBuildInProgress();

  // Before `ensureDeps`, deliberately: an unknown id must cost milliseconds,
  // not the 10–25 s install plus the codegen that precedes the composition
  // registry step where it would otherwise surface.
  assertKnownCompositions(opts.compositions);

  const root = await getWorktreeRoot();
  // The identity of the CHECKOUT. A CLI process has no RUNTIME namespace at
  // all — only a gateway-spawned backend does — so the question it can answer
  // is "which checkout am I standing in". `release` (the parent process)
  // resolves the release dist through the SAME function on the same root — it
  // spawns this command with `cwd` at that root — so the producer and the
  // consumer of the dist cannot land on different trees.
  const name = checkoutWorktreeName(root);
  // The namespace a plain build of this checkout would serve — what the reap
  // gate asks the gateway about and what the check transcript is keyed by. Equal
  // to `name` for every agent worktree today; not equal once a composition is
  // served from a non-main checkout, which is exactly what the brand catches.
  const namespace = await checkoutNamespace(root);

  // A release is NOT a build run, so `SINGULARITY_BUILD_ID` is deliberately
  // neither read nor written here: reading it would make a release adopt the
  // id of whatever build spawned it (and, through the profiler/log writers,
  // append to that build's artifacts); writing it would leak this id into
  // every child. The id exists only to name this run's artifacts and to be
  // written to `dist/.build-id`.
  const shortCommitProc = Bun.spawnSync(
    ["git", "rev-parse", "--short", "HEAD"],
    {
      cwd: root,
      stdout: "pipe",
    },
  );
  const shortCommit = shortCommitProc.stdout.toString().trim();
  const buildId = `${shortCommit || "nocommit"}-${Date.now()}`;

  // The commit every dist this run publishes is stamped with. Sampled HERE —
  // before stage 1 reads or rewrites a single file — for the same reason
  // `release.ts` reads its git provenance before spawning this child: a sample
  // taken after the compile names whatever the checkout moved to meanwhile, not
  // the tree the bytes came from. `null` when git could not answer; unknown must
  // read as unknown, and the release transcript below already says "(unknown)".
  const headProc = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: root,
    stdout: "pipe",
  });
  const headAtStart = headProc.stdout.toString().trim() || null;

  // The per-checkout artifact lock. REQUIRED, and the one non-obvious
  // hermetic step: it is the only thing serializing this run against a
  // concurrent `./singularity build` in the same checkout — both rewrite
  // the committed registries in it. `webDir` is used for the lock and for
  // NOTHING else: the lock is per-checkout because it guards codegen
  // written INTO the checkout, which is a separate question from where the
  // dist lands. A plain filesystem symlink, so it works on a bare host.
  const webDir = resolve(root, WEB_CORE_RELATIVE);
  await acquireArtifactLock(webDir);

  // WHICH dists this run publishes: a release's scratch dist per composition,
  // keyed by (this checkout, composition) — NOT the tree the gateway serves
  // for this namespace. That separation is the whole point: a release used to
  // publish over the checkout's live served dist and reclaim it, replacing
  // the running app with the composition until the next plain build.
  // Keying by checkout also makes the `.build.lock` above sufficient to
  // serialize two releases of the same composition, by construction.
  // research/2026-08-06-global-one-dist-per-namespace.md.
  const targets: ReleaseDistTarget[] = opts.compositions.map((composition) => ({
    kind: "release",
    worktree: name,
    composition,
  }));

  // Sweeping each dist dir's leftovers is the caller's job (see the
  // app-artifacts docblock) and must happen before any staging dir exists —
  // hence ALL N up front rather than one per composition inside the loop
  // below, where the first composition's staging dir would already be on disk.
  for (const target of targets) await sweepDistLeftovers(webDistPath(target));

  // Same one-shot migration reap as the deploy posture: a checkout that a
  // release runs in may still carry the pre-S4 in-checkout served dist, and a
  // release host may never run a plain deploy build. Gated on the RUNNING
  // GATEWAY already reporting the new location for this checkout's own
  // namespace, so it cannot delete a served tree. A bare release host has
  // no gateway — the gate simply stays closed, and such a host has no
  // served legacy dist to reclaim either. See ./legacy-dist-reap.ts.
  const reaped = await reapLegacyCheckoutDist({ webDir, namespace });
  if (reaped.kind === "skipped") {
    console.log(`Legacy in-checkout dist left in place: ${reaped.reason}`);
  } else if (reaped.entries.length > 0) {
    console.log(
      `Reclaimed ${reaped.entries.length} legacy in-checkout dist tree(s) from ${webDir}`,
    );
  }

  // Light observability seam: console only. No build profile, no
  // build-progress log, no footprint step — see the module docblock.
  const hooks: ArtifactHooks = {
    span: () => () => undefined,
    pushSpan: () => undefined,
    log: (line) => console.log(line),
    recordFootprint: (label, maxRssBytes) => {
      const line = maxRssLine(label, maxRssBytes);
      if (line !== null) console.log(line);
    },
  };

  // Stage 1 — dependencies + registry-level codegen + every composition's
  // filtered registries, off ONE plugin-tree walk.
  //
  // The manifest handed over is the CODE SEED, matching `assertKnownCompositions`
  // above: a release is a function of the source tree, so a composition that
  // exists only in someone's user-layer `compositions.jsonc` is deliberately not
  // releasable. The deploy posture reads the checkout's RESOLVED config instead
  // (`./build-targets.ts`) — the divergence is stated at both ends.
  await prepareCompositionSources({
    root,
    manifest: compositionsConfig.fields.manifests.defaultValue,
    compositions: opts.compositions,
    hooks,
  });

  // Stage 2 — migrations + manifest-level codegen + the mandatory config-override
  // seed.
  //
  // MAY TERMINATE THE PROCESS: exit 2 when drizzle-kit shows rename/create
  // prompts (printing the structured prompt JSON), exit 1 on a missing or
  // invalid `--migration-name`. `release` keys on those codes. NOTHING on this
  // path — above or below — installs an exit hook, a fatal-signal handler or a
  // verdict guard, so the code and the last line of stdout reach the parent
  // exactly as stage 2 wrote them. That is the contract this file's separation
  // from `run.ts` exists to keep true.
  await generateAppSources({
    root,
    migration: opts.migration,
    hooks,
  });

  // The `--skip-checks` validation set — always-run checks (incl.
  // `schema-files-loadable`, the net that catches a silently-dropped table
  // in this run's migration set) plus one incremental tsc per runtime
  // entrypoint. Shared with the deploy posture, so neither can drift on what a
  // fast artifact build still proves. Unconditional: the full checks pass is
  // build-specific observability and a release is downstream of it.
  //
  // Built ONCE per invocation, not per composition: it validates the SOURCE
  // TREE, which every composition in this run shares. Re-running it per dist
  // would re-prove the same tree N times.
  const companions = await fastValidationJobs({
    root,
    checkRunId: buildId,
    hooks,
  });

  const published: Array<{
    composition: string;
    live: string;
    staging: string;
  }> = [];
  let buildCommit = "";

  for (const [i, target] of targets.entries()) {
    // Composition names are the only thing separating N otherwise identical
    // step blocks in the transcript.
    if (targets.length > 1) {
      console.log(
        `\n── ${target.composition} (${i + 1}/${targets.length}) ──────────────`,
      );
    }

    // Stage 3 — the heavy section under ONE host CPU grant, then the atomic
    // dist publish. Interactive lane: a human or the release engine is
    // blocked on this, and there is no agent-branch fan-out to demote.
    // `gated: false` — the duress valve gates background-lane builds only, so
    // the hold would be inert anyway; saying so explicitly beats relying on
    // it. Real valve deps regardless, so the shape is never a test double.
    const artifact = await buildAndPublishWebDist({
      root,
      webDir,
      target,
      buildId,
      headAtStart,
      composition: target.composition,
      minify: opts.minify,
      // Self-contained dist: `release` copies this tree into the shippable
      // bundle, so every artifact must be REAL bytes, not a symlink into
      // this host's `~/.singularity/cache/web-artifacts/` store.
      materialize: true,
      // A release artifact is never experimental — it is the shipped app.
      experimental: false,
      lane: "interactive",
      priority: "normal",
      background: false,
      // Validation belongs to the SOURCE TREE, so it runs with the first
      // composition only — early enough that a broken tree fails before
      // burning N artifact builds, and once rather than N times. Reads like a
      // bug at a glance; it is the opposite.
      companions: i === 0 ? companions : [],
      admission: { gated: false, deps: createValveDeps() },
      onSteps: (steps) => printStepBlocks(steps),
      hooks,
    });

    if (!artifact.ok) {
      // Stage 3 already removed its staging dir, so nothing was published for
      // THIS composition and there is nothing left to reclaim. The step blocks
      // were printed by `onSteps` above; this is the roster that names the
      // failure.
      //
      // Fail fast rather than continuing: compositions in one invocation share
      // a plugin union, so a second failure is almost always the same failure
      // re-derived at ~10 min a go — and everything already published stays
      // published, which is why naming it here is not a consolation prize.
      const rest = targets.slice(i + 1).map((t) => t.composition);
      console.error(
        [
          "",
          `ARTIFACT BUILD FAILED — ${target.composition}: ${artifact.failedLabels.join(", ")}`,
          `  ${artifact.steps.map((s) => `${s.label} ${s.success ? "✓" : "✗"}`).join("   ")}`,
          `Nothing was published for "${target.composition}"; its release dist ` +
            `(${webDistPath(target)}) still resolves to the previous build of it. ` +
            `No served app was touched.`,
          published.length > 0
            ? `Already published: ${published.map((p) => p.composition).join(", ")} (left in place).`
            : "Nothing had been published yet.",
          rest.length > 0
            ? `Not attempted: ${rest.join(", ")}.`
            : "No later compositions remained.",
        ].join("\n"),
      );
      process.exit(1);
    }

    published.push({
      composition: target.composition,
      live: artifact.livePath,
      staging: artifact.stagingPath,
    });
    buildCommit = artifact.buildCommit;
  }

  console.log(
    [
      "",
      `Composition artifacts ready for ${published.map((p) => `"${p.composition}"`).join(", ")}:`,
      ...published.map((p) => `  ${p.composition}: ${p.live} → ${p.staging}`),
      `  build id:   ${buildId}`,
      `  commit:     ${buildCommit || "(unknown)"}`,
    ].join("\n"),
  );
}

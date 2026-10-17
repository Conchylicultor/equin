import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { existsSync } from "fs";
import { retryUntil, fixed } from "@plugins/packages/plugins/retry/core";
import { sweepDistLeftovers } from "./internal/dist-publish";
import {
  acquireArtifactLock,
  fastValidationJobs,
  generateAppSources,
  maxRssLine,
  prepareCompositionSources,
  webDistPath,
  type ArtifactHooks,
  type HeavyJob,
  type StepResult,
} from "./internal/app-artifacts";
import { resolveBuildTargets } from "./internal/build-targets";
import { deployNamespace } from "./internal/deploy-namespace";
import {
  hermeticFlagConflicts,
  runHermeticBuild,
} from "./internal/hermetic-build";
import { reapLegacyCheckoutDist } from "./internal/legacy-dist-reap";
import {
  assertMainTreeUntouched,
  snapshotTree,
} from "./internal/main-tree-guard";
import {
  WEB_CORE_RELATIVE,
  actAsCheckoutNamespace,
  checkoutRef,
  worktreeArtifacts,
  worktreeDataDir,
} from "@plugins/infra/plugins/paths/server";
import {
  MAIN_WORKTREE_NAME,
  NAMESPACE_RE,
  namespaceUrl,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import { join, resolve } from "path";
import { parseMigrationAnswers } from "@plugins/framework/plugins/cli/plugins/migrations/cli";
import { formatChangedSources } from "@plugins/framework/plugins/tooling/plugins/format/core";
import {
  buildProfilerStart,
  checkBroadcasts,
  checkValveGuard,
  createValveDeps,
  emitVerdict,
  finishBuildProgress,
  installFatalSignalExit,
  installVerdictGuard,
  laneFor,
  openBuildProgress,
  printStepBlocks,
  publishLane,
  pushBuildSpan,
  pushBuildStepLog,
  readCliCrash,
  renderVerdict,
  reportInterruptedPredecessor,
  runCheckSubprocess,
  signalOriginTap,
  valveGates,
  writeBuildLogs,
  writeBuildProfile,
  writeBuildReceipt,
  type BuildReceipt,
  type BuildReceiptStatus,
  type FatalSignal,
  type SignalTermination,
  type ValveDeps,
  type Verdict,
} from "@plugins/framework/plugins/cli/plugins/op-runtime/cli";
import {
  getMainRepoRoot,
  getWorktreeRoot,
  spawnCaptured,
} from "@plugins/infra/plugins/spawn/core";
import { registerMergeDrivers } from "@plugins/framework/plugins/cli/plugins/git-artifacts/cli";
import { assertPrerequisites } from "@plugins/framework/plugins/cli/plugins/doctor/cli";
import { installLockedToolchain } from "@plugins/infra/plugins/deps/plugins/mise/core";
import { clearMergeMarkers } from "@plugins/framework/plugins/cli/core";
import { markBuildInProgress } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  closeAdminPool,
  listDatabases,
  forkTempPrefix,
} from "@plugins/database/plugins/admin/server";
import { libpqEnv, readDatabaseConfig } from "@plugins/database/core";
import { PG_LOG_FILE } from "@plugins/database/plugins/embedded/server";
import { type Lane } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import {
  formatSignalOrigin,
  type SignalOrigin,
} from "@plugins/packages/plugins/signal-origin/core";
import { createOpProfiler } from "@plugins/debug/plugins/profiling/plugins/op-log/server";
import {
  markWorktreeOpStart,
  writeWorktreeSpec,
} from "@plugins/infra/plugins/worktree/server";
import { createBuildRunRecorder } from "@plugins/build/plugins/run-ledger/server";
import { buildRunIdKind } from "@plugins/build/plugins/run-ledger/core";
import { BUILD_EXIT_SUPERSEDED } from "@plugins/build/plugins/build-status/core";

// Wedge-breaker for the local `git` metadata reads in this file — orders of
// magnitude above what any of them take. A CLI command owns no deadline of its
// own (the human waiting is the deadline), so these could have been `unbounded`;
// they are not, because a wedged `git` child here hangs the whole build with no
// other ceiling anywhere — the fleet-level op-wedge watchdog was retired
// 2026-07-28 — and one minute is long enough that only a wedge trips it.
const GIT_TIMEOUT_MS = 60_000;

// A namespace is one or two dot-joined labels, capped at 63 bytes — owned by the
// namespace plugin and pinned to the gateway's own regex by
// `namespace:grammar-in-sync`. It used to be the single-LABEL rule here, which
// was right while a checkout's namespace was the only one this command could
// mint; `--composition` in a worktree mints `<composition>.<checkout>`.
const NAME_REGEX = NAMESPACE_RE;

// No central-routes manifest is written here. The central runtime publishes it
// itself on boot, from the routes it actually registered
// (central-core/bin/routes-manifest.ts). A build used to write it from its OWN
// checkout's tree — and since central runs main's code, a worktree on an older
// branch silently dropped routes central was serving.

/**
 * This checkout's HEAD, or `null` when git cannot answer. Failure is a value
 * here on purpose — the only caller compares two samples to decide whether the
 * tree moved, and an unreadable HEAD means "cannot tell", which must read as
 * "not superseded" rather than manufacture a difference.
 */
async function readHead(root: string): Promise<string | null> {
  const result = await spawnCaptured(["git", "rev-parse", "HEAD"], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

async function getCurrentBranch(): Promise<string> {
  const result = await spawnCaptured(
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) {
    console.error("Could not determine current branch");
    process.exit(1);
  }
  return result.stdout.trim();
}

// Self-heal `core.hooksPath`. `.githooks/prepare-commit-msg` is how each
// commit gets its Singularity-Conversation trailer, which in turn is how the
// pushes ledger attributes commits back to the originating task;
// `.githooks/post-rewrite` is what normalizes generated artifacts after a
// manual rebase. Drift here is silent in both cases — orphaned pushes, or a
// checkout carrying main's registry — so check on every build and reset to the
// tracked value.
async function ensureHooksPath(): Promise<void> {
  const read = await spawnCaptured(
    ["git", "config", "--get", "core.hooksPath"],
    {
      timeoutMs: GIT_TIMEOUT_MS,
    },
  );
  const current = read.stdout.trim();
  if (current === ".githooks") return;
  const write = await spawnCaptured(
    ["git", "config", "core.hooksPath", ".githooks"],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (write.exitCode !== 0) {
    if (write.stderr.trim()) console.error(write.stderr.trim());
    console.error(
      `Failed to set core.hooksPath=.githooks (was ${current ? `"${current}"` : "unset"}).`,
    );
    process.exit(1);
  }
  console.log(
    `Fixed core.hooksPath: was ${current ? `"${current}"` : "unset"}, now ".githooks"`,
  );
}

// Returns true once the forked DB exists. With atomic-publish forks (temp DB +
// rename as the last step — see plugins/database/plugins/admin/server/internal/fork.ts),
// the canonical name appears only when the fork fully completed, so an
// existence check against pg_database is sufficient — no need to probe table
// contents to distinguish a half-baked DB.
async function databaseReady(name: string): Promise<boolean> {
  // Use a direct pg client instead of `psql`: psql is not bundled by
  // embedded-postgres, and we'd rather not depend on the user's PATH for
  // routine readiness checks. Connect to `postgres` (the target may not exist
  // yet) and query pg_database for the target.
  const env = libpqEnv();
  const { Client } = await import("pg");
  const c = new Client({
    host: env.PGHOST!,
    port: parseInt(env.PGPORT!, 10),
    user: env.PGUSER!,
    database: "postgres",
    connectionTimeoutMillis: 1500,
  });
  try {
    await c.connect();
    const r = await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      name,
    ]);
    return (r.rowCount ?? 0) > 0;
  } catch (err) {
    // Any pg connection / query error means the DB is not ready yet.
    if (!(err instanceof Error)) throw err;
    return false;
  } finally {
    try {
      await c.end();
      // eslint-disable-next-line promise-safety/no-bare-catch
    } catch {}
  }
}

/**
 * Wait for the database to be reachable. Skipped when no managed services
 * are configured (externally managed DB, assumed ready).
 *
 * INTENTIONAL BEHAVIOR DELTA (recorded, not accidental): this used to call the
 * CLI's own ENOENT-throwing copy of `readDatabaseConfig`, so a missing
 * `~/.singularity/state/db-config/database.json` crashed HERE with a bare filesystem error.
 * Against the single tolerant reader it now falls through the
 * `services.length === 0` branch above ("externally managed DB") and the real,
 * actionable error comes from `waitForWorktreeDatabase` further down — which
 * knows *which* database it wanted and why. On any dev host `database.json`
 * always exists (`./singularity start` writes it), so no dev-loop invocation
 * changes; the delta only shows up on a bare host, where the old error named
 * the wrong problem.
 */
async function waitForPg(): Promise<void> {
  const config = readDatabaseConfig();
  if (config.services.length === 0) return;
  const env = libpqEnv();
  const { Client } = await import("pg");
  let lastErr: string | null = null;
  await retryUntil(
    async (attempt) => {
      const c = new Client({
        host: env.PGHOST,
        port: parseInt(env.PGPORT!, 10),
        user: env.PGUSER,
        database: "postgres",
        connectionTimeoutMillis: 1500,
      });
      try {
        await c.connect();
        await c.query("SELECT 1");
        await c.end();
        return true;
        // eslint-disable-next-line promise-safety/no-absorbed-failure -- readiness-probe retry: null signals "not ready yet, keep retrying" (lastErr captured for the deadline message); a genuine failure surfaces loudly via onDeadline → process.exit(1)
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        // Block form, not `eslint-disable-next-line`: the format pass splits
        // this one-liner across four lines, which moves a positional directive
        // off the `catch {}` it was written for. A disable/enable PAIR is a
        // line RANGE and survives any reflow (see `lint-directives-stable`).
        /* eslint-disable promise-safety/no-bare-catch -- best-effort teardown of a probe client that may never have connected: there is no caller to propagate to, and a close error could only mask the probe failure we are actually reporting */
        try {
          await c.end();
        } catch {}
        /* eslint-enable promise-safety/no-bare-catch */
        if (attempt === 0)
          console.log("Waiting for embedded Postgres to be ready...");
        return null;
      }
    },
    {
      delay: fixed(500),
      deadline: 60_000,
      onDeadline: () => {
        console.error(
          `ERROR: embedded Postgres did not become ready within 60s (last: ${lastErr ?? "no response"}).`,
        );
        console.error(`Check ${PG_LOG_FILE} for details.`);
        process.exit(1);
      },
    },
  );
}

// Where a stuck or failed fork is diagnosed. `database.fork` is enqueued and
// supervised by MAIN's backend, so its dead-letter is on main's Debug → Queue and
// its transcript (the detached child's output) is main's `database-fork` log.
function forkDiagnosisHint(): string {
  const forkLog = join(
    worktreeDataDir(MAIN_WORKTREE_NAME),
    "logs",
    "database-fork.jsonl",
  );
  return (
    `Check Debug → Queue on the main app for a dead \`database.fork\` job, ` +
    `and the fork's log at ${forkLog}.`
  );
}

async function waitForWorktreeDatabase(name: string): Promise<void> {
  if (await databaseReady(name)) return; // standard path, ~always already done

  const inFlight = (await listDatabases()).some((d) =>
    d.startsWith(forkTempPrefix(name)),
  );

  if (inFlight) {
    // A fork is actively restoring (temp DB exists). Be patient.
    const done = await retryUntil(
      async (attempt) => {
        if (await databaseReady(name)) return true;
        if (attempt === 0)
          console.log(`DB fork for "${name}" in progress; waiting…`);
        return null;
      },
      { delay: fixed(1_000), deadline: 120_000, onDeadline: () => false },
    );
    if (done) return;
    console.error(
      `ERROR: DB fork for "${name}" did not finish within 120s. ` +
        forkDiagnosisHint(),
    );
    process.exit(1);
  }

  // No DB and no restore in flight. Either a standard-path job is still queued/
  // gated, or this worktree was created outside Singularity and has no job at
  // all. Grace-poll for the queued case, then fail actionably. 60 s, not less:
  // the fork runs in a detached `supervised-exec` child, which spends an exec
  // boot of the whole plugin graph (then the fork plan) before it creates the
  // temp DB — so "no temp yet" is the normal state for the first stretch of a
  // healthy fork.
  const done = await retryUntil(
    async (attempt) => {
      if (await databaseReady(name)) return true;
      if (attempt === 0) console.log(`Waiting for DB fork "${name}"…`);
      return null;
    },
    { delay: fixed(1_000), deadline: 60_000, onDeadline: () => false },
  );
  if (done) return;
  console.error(
    [
      `ERROR: no database for "${name}" and no fork in flight after 60s.`,
      "",
      "If this worktree was created from Singularity, its fork may have failed.",
      forkDiagnosisHint(),
      "",
      "If this worktree was created outside Singularity (git worktree add),",
      "create its database with:",
      "",
      "    ./singularity db fork",
      "",
      "Then re-run ./singularity build.",
    ].join("\n"),
  );
  process.exit(1);
}

/**
 * The MAIN checkout's database is nobody's copy: every other database in the app
 * is minted from it (a worktree's is a `pg_dump | pg_restore` of it, `db fork`
 * copies it by name), so there is no fork and no job to wait for here. Starting
 * the cluster creates it — `plugins/database/plugins/embedded/scripts/start.ts`,
 * which the gateway's supervisor runs. If it is absent, nothing is in flight and
 * polling would only spend a minute before saying the same thing, so this fails
 * at once.
 *
 * The build itself creates NOTHING: provisioning storage is not a build's job,
 * and the base database must not depend on someone having run a build.
 */
async function requireBaseDatabase(name: string): Promise<void> {
  if (await databaseReady(name)) return;

  // With `services: []` the user runs their own Postgres and the app supervises
  // nothing — so the start script never runs, and we do not provision inside a
  // cluster the app does not own. Name the command that creates it instead.
  const selfHosted = readDatabaseConfig().services.length === 0;
  console.error(
    [
      `ERROR: no database for "${name}".`,
      "",
      ...(selfHosted
        ? [
            "This host runs its own Postgres (no managed services configured),",
            "so nothing here creates the base database. Create it with:",
            "",
            `    createdb ${name}`,
          ]
        : [
            "The bundled Postgres creates it when the cluster starts. Start it with:",
            "",
            "    ./singularity start",
          ]),
      "",
      "Then re-run ./singularity build.",
    ].join("\n"),
  );
  process.exit(1);
}

// `/gateway/worktrees` is the gateway's own API and exists on every gateway
// version — a 200 here proves the gateway is alive. Central's own readiness
// is covered by the gateway's waitReady on its Unix socket; no separate
// central-side liveness probe.
async function probeGatewayHealth(): Promise<string | null> {
  console.log("Probing gateway /gateway/worktrees...");
  const url = "http://localhost:9000/gateway/worktrees";
  let lastStatus: number | string = "no response";
  const result = await retryUntil<true, string | null>(
    async () => {
      try {
        const resp = await fetch(url);
        if (resp.ok) return true;
        lastStatus = resp.status;
      } catch (err) {
        lastStatus = err instanceof Error ? err.message : String(err);
      }
      return null;
    },
    {
      delay: fixed(250),
      deadline: 10_000,
      onDeadline: () => {
        console.warn(
          `Gateway did not become healthy within 10s (last: ${lastStatus}). ` +
            `Build artifacts are valid; gateway will retry on next request.`,
        );
        return "gateway still starting";
      },
    },
  );
  return result === true ? null : result;
}

/**
 * The options commander parses for `build`, i.e. the flags declared in
 * `./index.ts` — `--no-restart` / `--no-minify` are the negatable pair, which is
 * why `restart` and `minify` are plain booleans that default to true.
 */
interface BuildOptions {
  hermetic?: boolean;
  composition?: string[];
  migrationName?: string;
  resetMigration?: boolean;
  customMigration?: boolean;
  migrationAnswers?: string;
  restart: boolean;
  skipChecks?: boolean;
  allowMain?: boolean;
  minify: boolean;
}

const run: CliAction<[], BuildOptions> = async (opts) => {
  // ── Posture branch, and it is the LITERAL FIRST STATEMENT on purpose ──
  //
  // `build` has two postures over one shared pipeline
  // (./internal/app-artifacts.ts): DEPLOY this checkout into the live dev
  // cluster (the default, everything below), or produce a composition's
  // artifact set HERMETICALLY (--hermetic --composition, which is what
  // `release` shells into).
  //
  // The hermetic body's defining property is that none of the deploy
  // machinery this action arms — the build-progress log, the op profiler,
  // the run-ledger recorder, the worktree-op marker, the exit hook, the
  // verdict guard, the fatal-signal handler, the deploy receipt — is armed
  // at all, so stage 2's exit 2 (drizzle prompt) / exit 1 (missing
  // --migration-name) reaches `release` unrewritten and unburied. Branching
  // BEFORE the first of them (`markBuildInProgress`, which
  // `runHermeticBuild` calls itself) is what makes that structural instead
  // of a claim maintained by ~20 scattered `if (!hermetic)` guards.
  if (opts.hermetic) {
    const conflicts = hermeticFlagConflicts(opts);
    if (conflicts.length > 0) {
      console.error(
        [
          "ERROR: incompatible flags for --hermetic.",
          "",
          ...conflicts.map((c) => `  - ${c}`),
        ].join("\n"),
      );
      process.exit(1);
    }
    return await runHermeticBuild({
      // Non-empty by `hermeticFlagConflicts` above.
      compositions: opts.composition ?? [],
      migration: {
        name: opts.migrationName,
        reset: opts.resetMigration,
        custom: opts.customMigration,
        answers: opts.migrationAnswers
          ? parseMigrationAnswers(opts.migrationAnswers)
          : undefined,
      },
      minify: opts.minify,
    });
  }

  // The releases mise.lock records, installed if a lock arrived without them
  // (a clone, a pull, an upstream merge) — before the doctor, which would
  // otherwise only report them missing.
  const installed = await installLockedToolchain(await getWorktreeRoot());
  if (installed.length > 0)
    console.log(`Installed the locked toolchain: ${installed.join(", ")}`);
  // Every missing dev prerequisite at once, before any of the ~10 minutes
  // below — the hermetic posture above launches no agent and needs none.
  await assertPrerequisites();

  // Mark this process as a build: dist-comparing checks (map-in-sync) skip
  // while the dist they'd inspect is the one this build replaces.
  markBuildInProgress();

  let endSpan = buildProfilerStart(
    "ensureHooksPath",
    "build:preflight",
    "ensureHooksPath",
  );
  await ensureHooksPath();
  endSpan();

  endSpan = buildProfilerStart(
    "registerMergeDrivers",
    "build:preflight",
    "registerMergeDrivers",
  );
  await registerMergeDrivers(await getWorktreeRoot());
  endSpan();

  endSpan = buildProfilerStart(
    "branchGuard",
    "build:preflight",
    "branch guard",
  );
  const branch = await getCurrentBranch();
  if (branch === "main" && !opts.allowMain) {
    console.error(
      [
        "ERROR: refusing to build from the main branch.",
        "",
        "Agents should work in a worktree, not directly on main.",
        "If you are inside a worktree conversation, make sure you are running",
        "this command from the worktree directory, not the main repo.",
        "",
        "To override (only with explicit user permission): ./singularity build --allow-main",
      ].join("\n"),
    );
    process.exit(1);
  }
  endSpan();

  endSpan = buildProfilerStart(
    "checkBroadcasts",
    "build:preflight",
    "checkBroadcasts",
  );
  await checkBroadcasts("build");
  endSpan();

  const root = await getWorktreeRoot();
  // The checkout half of every namespace this invocation touches — minted
  // once, because every target of one build is built from one tree.
  const checkout = await checkoutRef(root);
  // THIS CHECKOUT's own namespace. It is not necessarily a target (a
  // composition-only build publishes nobody else's namespace and not this
  // one), but it is the key everything INVOCATION-scoped is filed under:
  // the progress log, the op marker, the op profiler, the build profile,
  // the transcript and the `build_runs` row. Those must live where the
  // backend that serves this checkout can read them — see the artifact
  // locality note in the phase plan.
  const name = await actAsCheckoutNamespace(root);

  // WHAT this invocation deploys, decided before anything is spent: an
  // unknown composition, an illegal id or an occupied namespace costs
  // milliseconds here rather than ten minutes at the step that would
  // otherwise have noticed. Throws; `runCli` renders it.
  const { manifest, targets } = await resolveBuildTargets({
    root,
    requested: opts.composition ?? [],
    checkout,
  });

  // Open the durable, crash-safe build-progress log now that `name` (the same
  // namespace key the op marker and writeBuildProfile use) is known. Every
  // buildProfilerStart span from here on records an enter/leave + RSS to
  // ~/.singularity/logs/build-progress/build-progress.jsonl, so a wedged build names its phase and
  // heap trend even after SIGKILL. See research/2026-07-21-global-cli-op-wedge-gc-sink.md.
  //
  // ONE progress run per PROCESS, keyed on the checkout's namespace: the
  // module holds a single `current`, so a second `openBuildProgress` would
  // be a silent no-op rather than a second log.
  openBuildProgress(name, process.env.SINGULARITY_BUILD_ID ?? null);

  // Report a predecessor that never completed, BEFORE this build overwrites
  // its receipt. Self-healing on purpose: the previous build was SIGKILLed, so
  // it printed no verdict and set no exit code — this line is the only place
  // that fact ever surfaces without someone thinking to go looking for it.
  // Per TARGET: the receipt is per-namespace, so an interrupted predecessor
  // is a fact about the namespace this build is about to overwrite.
  for (const target of targets) reportInterruptedPredecessor(target.namespace);

  // Every build needs ONE stable id, shared by its build-log record, its
  // build-profile-<id>.json, its build-logs, and the bundle's .build-id —
  // so the profiling Gantt can open ANY build's detail by id, not just
  // UI-triggered ones. UI builds already set SINGULARITY_BUILD_ID
  // (run-build.ts); manual CLI builds (`./singularity build`) get a
  // generated one here. Write it back into the env so the profiler and
  // build-logs writers (which read the env var at write time) agree by
  // construction instead of falling back to id-less default filenames and
  // a null build-log buildId (which left manual builds un-clickable).
  // A UI/auto build's backend minted the build_runs row before spawning this
  // CLI (SINGULARITY_BUILD_ID is that row's id); a manual `./singularity
  // build` has no such id yet. Captured BEFORE the env is overwritten below,
  // so the CLI knows whether it must mint main's row itself (decision 3).
  const uiTriggered = process.env.SINGULARITY_BUILD_ID != null;
  // Minted through the run ledger's id kind, like the backend's claim: one
  // shape (`build-<s>-<6>`) whoever started the build, so a manual build's id
  // is recognised (chips, the run pane) exactly like a UI build's.
  const buildId: string =
    process.env.SINGULARITY_BUILD_ID ?? buildRunIdKind.mint();
  process.env.SINGULARITY_BUILD_ID = buildId;

  // A main build is human-blocking (interactive lane); an agent build is
  // background. Derived ONCE, here, because two consumers need the same
  // fact: this record (the lane explains WHY a wait was as long as it was)
  // and the heavy section's `withHostGrant` below.
  const lane: Lane = laneFor(branch === "main");

  // The op log's record for this build. `markRequested` lands where the old
  // build-log "started" record did — but the old record's `startedAt` was
  // ALSO the bar's start, stamped before `acquireCheckoutLock`, so `totalMs`
  // silently swallowed every wait: a build that queued 5 min and worked 1
  // rendered identically to one that worked 6. Here the waits below are
  // recorded as their own segments instead.
  //
  // `opId` is `buildId`: unique and non-null on every path (a UI build gets
  // SINGULARITY_BUILD_ID from run-build.ts, a manual CLI build the minted
  // `build-<s>-<6>` above). `buildId` is passed AGAIN, separately, because
  // it means something else there — the join key to build-profile-<id>.json,
  // which is what makes a bar's span breakdown openable.
  const profiler = createOpProfiler("build", {
    opId: buildId,
    branch,
    opSlug: name,
    lane,
    buildId,
  });
  // This build's liveness marker (see worktree-op.ts): a flocked
  // `ops/<buildId>.json`, published BEFORE `requested` so the op log never
  // holds a build no marker vouches for, and released in finalizeBuild only
  // AFTER the terminal is appended. The tmux status poller keeps the agent's
  // pane "working" while it is held; a SIGKILL drops the lock with the process
  // and the op-store reconciler closes the build as interrupted.
  const marker = markWorktreeOpStart(name, "build", buildId);
  profiler.markRequested();

  // The CLI-side build_runs ledger writer, against THIS CHECKOUT's own
  // database. ONE row per invocation, whatever it built: the transcript,
  // the profile and the verdict are already one-per-process, so N rows
  // would each point at the same three artifacts. It used to be hardcoded
  // to main's DB and gated to main builds, because the only rows it wrote
  // were main's deploy and its compose-serve children; an agent worktree
  // now mints rows too, which is visible in every worktree's Build UI and
  // is the honest record. Released in finalizeBuild so every graceful exit
  // drops the pool.
  const recorder = createBuildRunRecorder(name);

  // Guarantee a terminal record on every *graceful* exit path — a thrown
  // build step, process.exit(1), or SIGINT/SIGTERM. Without this, any
  // failure before the explicit success/failure writes below leaves a
  // `requested` with no `completed`, which the reader can only render as an
  // ever-growing fake bar with no real end time. The exit handler captures
  // the true end timestamp. Only a hard kill (SIGKILL/OOM/power loss) —
  // which can't run handlers — legitimately leaves a record open; those are
  // the orphans the op-store reconciler closes as "interrupted".
  // Mirrors the on-exit lock release in acquireCheckoutLock above.
  //
  // The deploy receipts this build owns, ONE PER TARGET NAMESPACE. A receipt
  // is per-namespace by definition — it is the file the gateway-facing
  // deploy answers for, and `build --composition sonata website` answers for
  // two — so this is a Map rather than the single value it used to be. Each
  // entry is opened `running` just before its target deploys, and a target
  // that finishes closes its own; whatever is still open when the process
  // ends is closed here. Empty until the build lock is granted, and
  // deliberately so: a build that dies before it owns the lock published
  // nothing and must not overwrite its predecessor's receipts.
  const receipts = new Map<Namespace, BuildReceipt>();
  /** Stamp one namespace's receipt terminal, and remember that it is. */
  const closeReceipt = (
    ns: Namespace,
    status: BuildReceiptStatus,
    exitCode: number,
  ): void => {
    const open = receipts.get(ns);
    if (open === undefined || open.finishedAt !== null) return;
    const closed: BuildReceipt = {
      ...open,
      status,
      finishedAt: new Date().toISOString(),
      exitCode,
    };
    receipts.set(ns, closed);
    writeBuildReceipt(ns, closed);
  };
  let buildFinalized = false;
  const finalizeBuild = async (
    success: boolean,
    terminal?: { status: BuildReceiptStatus; exitCode: number },
  ): Promise<void> => {
    if (buildFinalized) return;
    buildFinalized = true;
    // Stamp every STILL-OPEN receipt's terminal status. Synchronous, so the
    // exit-hook backstop lands it too — and a SIGKILL, which runs no hook at
    // all, is exactly what leaves a receipt at `running` with a dead pid.
    // That absence IS the "did not complete" signal; nothing else has to
    // detect it.
    //
    // Already-closed entries are skipped rather than re-stamped: a target
    // that published before a LATER target failed is deployed, and saying
    // `failed` on its namespace's receipt would be a plain lie about the app
    // now serving there.
    //
    // The spread carries `signal` through: recordSignal restamps every open
    // receipt when a catchable signal arrives, so a killed build's terminal
    // record is `failed` + the real exit code + the signal — never confusable
    // with a `failed` + exit 1 from the build's own checks. Every caller now
    // supplies `terminal` on the failure paths (the exit hook included), so
    // the `exitCode: null` fallback is reachable only from
    // `finalizeBuild(true)`, where the `success ? 0` arm wins.
    for (const [ns, receipt] of receipts) {
      if (receipt.finishedAt !== null) continue;
      writeBuildReceipt(ns, {
        ...receipt,
        status: terminal?.status ?? (success ? "ok" : "failed"),
        finishedAt: new Date().toISOString(),
        exitCode: terminal?.exitCode ?? (success ? 0 : null),
      });
    }
    // Close the durable build-progress run. A wedge is exactly the build that
    // never reaches this hook, so no `done` line + a live pid = wedged mid-phase
    // (outstanding span names it); a `done` line + a live pid = the
    // "hung on exit after finishing" case (occ. C).
    finishBuildProgress(success);
    profiler.complete(success ? "success" : "failed");
    profiler.write();
    // Only now: the verdict is in the log, so a reader that sees the marker
    // gone finds the terminal rather than an op that looks killed.
    marker.release();
    // Release the DB pools LAST, after every synchronous durable write
    // above. The process.on("exit") backstop below can run this sync body
    // but cannot await — that's fine: the profile / log / op record is
    // already flushed by the sync writes, and the pools' sockets are
    // OS-reaped on process exit.
    //
    // `closeAdminPool` used to be the compose-serve stage's own `finally`,
    // as "the build's last DB user". In a loop that reading is wrong: the
    // first target's close would end the pool the SECOND target's
    // `ensureDatabase` needs. The build's last DB user is the build.
    await closeAdminPool();
    await recorder.close();
  };
  // The exit backstop can only run synchronous work; the recorder.close()
  // await inside finalizeBuild is abandoned here (see the comment above), so
  // discard the returned promise rather than float it.
  //
  // The `code` argument is threaded through, and that is the whole point of
  // this hook now. It used to be dropped — `() => void finalizeBuild(false)`
  // — which sent every ungraceful exit down the `terminal === undefined`
  // branch above and wrote `exitCode: null`. A build killed by SIGTERM
  // (exit 143) therefore landed on disk as `status:"failed", exitCode:null`,
  // indistinguishable from a build that failed its own checks
  // (`status:"failed", exitCode:1`). That ambiguity is what made the
  // 2026-08-06 incident take hours to attribute; the real code, plus the
  // `signal` stamped by recordSignal below, is what removes it.
  process.on(
    "exit",
    (code) => void finalizeBuild(false, { status: "failed", exitCode: code }),
  );

  // What ended this process, when a catchable fatal signal did. Recorded on
  // the signal, read on the exit path — by the receipts (below) and by the
  // verdict guard, which pulls it lazily.
  let termination: SignalTermination | null = null;
  const recordSignal = (
    signal: FatalSignal,
    origin: SignalOrigin | null,
  ): void => {
    // The origin comes from the shared tap, which read it after the native
    // handler had already run (it sits underneath Bun's own and chains up to
    // it) — so it is the sender's identity, not a guess. Unarmed (no
    // toolchain, disabled by env) reads null and the record simply carries no
    // attribution; the arm failure was already written to the sink, so
    // "nobody sent a signal" and "we could not tell who did" stay distinct.
    termination = {
      signal,
      at: new Date().toISOString(),
      ...(origin === null ? {} : { attribution: formatSignalOrigin(origin) }),
    };
    // Nothing to stamp before the build owns a receipt (a build that dies
    // while still queuing must not overwrite its predecessor's — see above),
    // and nothing to stamp after finalizeBuild wrote a terminal status.
    if (buildFinalized) return;
    // Stamp NOW rather than only in finalizeBuild, on every receipt still
    // open. An escalating kill — SIGTERM then SIGKILL, which is what
    // `timeout -k` and most supervisors send — never reaches the exit hooks,
    // so this synchronous write is the only record that a catchable signal
    // arrived at all. It keeps `status: "running"`, so the receipt still
    // resolves as `interrupted`; it just now says what interrupted it.
    for (const [ns, open] of receipts) {
      if (open.finishedAt !== null) continue;
      const stamped: BuildReceipt = { ...open, signal };
      receipts.set(ns, stamped);
      writeBuildReceipt(ns, stamped);
    }
  };

  // The build cannot terminate without printing its own verdict. Registered
  // after finalizeBuild's exit hook so handlers run in order and the
  // banner is written last. Earlier exits (getWorktreeRoot, name/branch
  // guards, parseMigrationAnswers) fire before this point and before any
  // artifact is touched, so there is no deploy ambiguity for them to resolve.
  // Declared here rather than beside its first heavy use: the verdict guard,
  // the deploy receipts and the verdicts must all name the same URLs. One
  // per target — a killed multi-target build published nothing, so every
  // namespace it named is still on its previous dist and the banner has to
  // say so about all of them.
  const targetUrls = targets.map((t) => namespaceUrl(t.namespace));

  installVerdictGuard({
    urls: targetUrls,
    buildLogPath: worktreeArtifacts.buildLogText(name, buildId),
    // Pulled at exit time, not passed by value: the signal can arrive at any
    // point after this call. With it the guard prints BUILD ABORTED rather
    // than BUILD FAILED for a build that was killed rather than broken.
    termination: () => termination,
    // Same lazy pull, for the other way a build can end without reaching its
    // own funnel: an unhandled throw. `runCli` records it as it unwinds, so
    // the banner (and build.log, via onFallback) names the exception instead
    // of reporting a failure with no cause at all.
    crash: () => readCliCrash(),
    // A build killed here reaches none of the writeBuildLogs calls below, so
    // the guard writes the transcript its own pointer names. Whatever steps
    // had closed by then are all green (the one it died inside never closed),
    // which is why the artifact carries the exit code rather than letting a
    // reader infer it — see BuildLogs.exitCode.
    onFallback: (v, code) => writeBuildLogs(name, renderVerdict(v), code),
  });

  // Catchable fatal signals → graceful exit so the exit handlers above
  // (build-log finalize) and the lock release run. SIGKILL is uncatchable —
  // the kernel dropping acquireCheckoutLock's flock is the backstop there.
  // `onSignal` records the death BEFORE the exit hooks run, so both of them
  // see it. See fatal-signals.ts for the shared map and the ordering rule.
  //
  // The tap (arm + sink line) is the same wiring `check` and `push` install;
  // it lives in ../signal-origin-tap.ts, including the reason its arm may
  // only happen inside `afterInstall`. Arming here — rather than in the
  // bootstrap — keeps signal coverage byte-identical to what it was before
  // this change, so the tap adds no regression surface. `recordSignal` is
  // what is build-specific: the receipt stamp and the verdict's termination.
  installFatalSignalExit(
    await signalOriginTap({
      opId: buildId,
      worktree: name,
      onSignal: recordSignal,
    }),
  );

  endSpan = buildProfilerStart(
    "nameValidation",
    "build:preflight",
    "name validation",
  );
  if (!NAME_REGEX.test(name)) {
    console.error(`Invalid worktree name "${name}". Must match ${NAME_REGEX}`);
    process.exit(1);
  }
  endSpan();

  endSpan = buildProfilerStart(
    "acquireBuildLock",
    "build:setup",
    "acquire build lock",
  );
  const webDir = resolve(root, WEB_CORE_RELATIVE);
  await profiler.wait("build-lock", () => acquireArtifactLock(webDir));
  // The build lock is this build's ENTRY ticket, so this is where it stops
  // queuing and starts its own work. It is NOT done waiting: the duress
  // valve and the host grant below are both post-`granted`, and are where a
  // contended build actually spends its minutes.
  profiler.markGranted();
  endSpan();

  // The commit this build is FOR — sampled here because the lock is granted
  // and nothing has been read yet, so it brackets every source read the
  // build goes on to make. `push` merges into the SHARED main worktree
  // without waiting for a build, so this can change underneath us; when it
  // does, reads from before and after the merge answer for different trees
  // and the build's verdict is about no coherent tree at all. See
  // `supersededBy` at the verdict funnels below.
  const headAtStart = await readHead(root);

  /**
   * Open one target's deploy receipt. AFTER the lock, not before: the lock
   * serializes builds in this checkout, so exactly one build owns a
   * namespace's receipt at a time and a queued build cannot overwrite a live
   * one's. `headAtStart` is the commit it answers for.
   *
   * Its `logPath` points into THIS CHECKOUT's artifacts, not the target's:
   * one invocation writes one transcript, and every receipt it opens points
   * a reader at that same file.
   */
  const openReceipt = (ns: Namespace): void => {
    const receipt: BuildReceipt = {
      status: "running",
      buildId,
      commit: headAtStart,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      url: namespaceUrl(ns),
      logPath: worktreeArtifacts.buildLogText(name, buildId),
    };
    receipts.set(ns, receipt);
    writeBuildReceipt(ns, receipt);
  };

  endSpan = buildProfilerStart(
    "sweepStaging",
    "build:setup",
    "sweep staging leftovers",
  );
  // Sweep EVERY target's dist leftovers up front, before any staging dir
  // exists — the same reason `hermetic-build.ts` does it this way.
  // Sweeping inside the deploy loop would delete target 2's staging dir
  // while target 1's is still live.
  for (const target of targets) {
    await sweepDistLeftovers(
      webDistPath({ kind: "served", name: target.namespace }),
    );
  }
  // One-shot migration: reclaim the served dist that used to live inside the
  // checkout. Gated on the RUNNING GATEWAY already reporting the new
  // location for this namespace — the only authority on what it is serving
  // — so it can never delete a live tree; see ./internal/legacy-dist-reap.ts.
  const reaped = await reapLegacyCheckoutDist({
    webDir,
    namespace: name,
  });
  if (reaped.kind === "skipped") {
    console.log(`Legacy in-checkout dist left in place: ${reaped.reason}`);
  } else if (reaped.entries.length > 0) {
    console.log(
      `Reclaimed ${reaped.entries.length} legacy in-checkout dist tree(s) from ${webDir}`,
    );
  }
  endSpan();

  // The non-heavy phases — `bun install`, drizzle generate, and the build
  // orchestrator process itself — run outside every host grant and, unlike
  // the heavy steps, produce no StepResult, so their maxRSS lines have no
  // step block to ride into build.log. Rather than invent a second log
  // mechanism, they are collected here and flushed as ONE synthetic step
  // through the same `pushBuildStepLog` seam the heavy steps use — so
  // `grep maxRSS <build.log>` finds every measured phase of a build in one
  // place, which is exactly what the calibration pass needs. See
  // research/2026-07-12-global-host-admission-memory-dimension.md (gap 0).
  const footprintLines: StepResult["lines"] = [];
  const recordFootprint = (
    label: string,
    maxRssBytes: number | undefined,
  ): void => {
    const line = maxRssLine(label, maxRssBytes);
    if (line === null) return;
    console.log(line);
    footprintLines.push({ text: line, stream: "stdout" });
  };
  // Flushed on every path that persists the build's artifacts (both writers
  // read a module-level array, so this must run before them). Samples the
  // orchestrator's own footprint here: `process.resourceUsage().maxRSS` is a
  // TRUE peak (getrusage RUSAGE_SELF; Bun reports it in bytes), not an
  // instantaneous sample, so it covers every in-process phase — registry /
  // manifest / composition codegen, config propagation — no matter when it
  // is read. The check pass is no longer among them: it is a child process
  // now, and reports its own peak through this same seam. Idempotent.
  let footprintFlushed = false;
  const flushFootprint = (): void => {
    if (footprintFlushed) return;
    footprintFlushed = true;
    const orchestratorRss = process.resourceUsage().maxRSS;
    recordFootprint("build orchestrator", orchestratorRss);
    // The build profile carries spans only, and the profiling UI's phase set
    // is a closed list (debug/profiling/build/web/phases.ts), so the
    // orchestrator's peak rides a zero-width marker span in an existing
    // phase rather than inventing one the Gantt could not render.
    buildProfilerStart(
      "buildOrchestrator",
      "build:deploy",
      "build orchestrator",
    )({
      maxRssBytes: orchestratorRss,
    });
    if (footprintLines.length > 0) {
      pushBuildStepLog({
        id: "resourceUsage",
        label: "resource usage",
        lines: footprintLines,
        durationMs: 0,
        success: true,
      });
    }
  };

  // build's observability seam into the shared app-artifact pipeline. These
  // ARE the profiler / console / footprint sinks used everywhere else in
  // this action, so every span id, phase, label and `maxRSS` line the
  // pipeline emits is build's own, by construction rather than by copying.
  const hooks: ArtifactHooks = {
    span: buildProfilerStart,
    pushSpan: pushBuildSpan,
    log: (line) => console.log(line),
    recordFootprint,
  };

  // Main's tree as git sees it BEFORE the first writer below — compared after
  // the last one (the formatter), because main's build may write nothing git
  // tracks. See ./internal/main-tree-guard.ts.
  const mainTreeBefore =
    checkout.kind === "main" ? await snapshotTree(root) : null;

  // Stage 1 — dependencies + registry-level codegen + every target's
  // filtered registry. Runs before central is spawned below (its
  // plugins.generated.ts must be in sync). See ./internal/app-artifacts.ts.
  //
  // The manifest handed over is THIS CHECKOUT's resolved `compositions`
  // config, already read by `resolveBuildTargets` — the same document the
  // targets came from, so `extends` resolves against what this checkout
  // declares. Deliberately different from the hermetic posture, which reads
  // the code seed; see `readCheckoutCompositions`.
  //
  // A plain build passes the main composition's id, which emits NO filtered
  // registry: the main composition's registry IS the committed
  // `<dir>.generated.ts`, so stage 1 has nothing to write and skips the
  // plugin-tree walk entirely.
  await prepareCompositionSources({
    root,
    manifest,
    compositions: targets.map((t) => t.composition),
    hooks,
  });

  // 2b'. Write the central spec early too — otherwise the gateway has no
  // way to spawn central. (Repeated at end of build for idempotency.)
  // central.json always points at *main's* central-core/, not the current
  // worktree's: central is a singleton serving every worktree, so the
  // canonical source is main. The file is idempotent across worktree
  // builds — same content every time.
  endSpan = buildProfilerStart("centralJson", "build:codegen", "central.json");
  const mainRoot = await getMainRepoRoot();
  const centralDir = resolve(
    mainRoot,
    "plugins/framework/plugins/central-core",
  );
  if (existsSync(join(centralDir, "bin", "index.ts"))) {
    // No `composition`: central is not an app. It is a singleton API
    // runtime with its own registry (`central.generated.ts`), which no
    // composition filters, so there is nothing for one to select.
    writeWorktreeSpec({ name: "central", server: centralDir });
  }
  endSpan();

  // 2c. Ensure the embedded Postgres cluster is up. The gateway owns
  // PG supervision now (see gateway/postgres.go) and answers
  // /api/database/status from its own state — central is not involved.
  endSpan = buildProfilerStart(
    "waitForPg",
    "build:database",
    "wait for Postgres",
  );
  await waitForPg();
  endSpan();

  // 2d. Ensure this checkout's own database is there: main's base database, or
  // a worktree's fork (forked asynchronously during conversation creation).
  //
  // This IS the main-composition target's database step, HOISTED out of the
  // per-target loop, and for two reasons worth naming: the `build_runs` row
  // this invocation opens a few lines below lives in that database, and a
  // missing database must fail in seconds rather than after the frontend build.
  // Skipped entirely for a composition-only build — that invocation neither
  // publishes this checkout's app nor needs its data, and on a fresh
  // checkout the fork may legitimately not exist yet (the ledger degrades
  // to a note; see `insertRun`).
  //
  // WHICH database this is decides how it comes into existence, so the two
  // cases are not the same step. A worktree's is a fork, made asynchronously by
  // a job, and waiting for it is right. The MAIN checkout's is nobody's copy —
  // no fork, no job — so it is checked once and never waited for. The predicate
  // is git's answer (`checkoutRef`), never a comparison against the namespace
  // string: a linked worktree whose directory happens to be named
  // `singularity` mints the same namespace as main.
  if (targets.some((t) => t.isMainComposition)) {
    const isMainCheckout = checkout.kind === "main";
    endSpan = buildProfilerStart(
      "waitForDatabase",
      "build:database",
      isMainCheckout ? "check base DB" : "wait for DB fork",
    );
    if (isMainCheckout) await requireBaseDatabase(name);
    else await waitForWorktreeDatabase(name);
    endSpan();
  }

  // Soft-degrade notes folded into the final OK verdict headline (server
  // still booting under host load, gateway starting, a lost or missing
  // build-runs row). Declared here so the row mint just below can report one.
  const softNotes: string[] = [];

  // Mint THIS INVOCATION's single build_runs row for a manual terminal
  // build: a UI/auto build's backend already minted it (uiTriggered) and
  // stamped its own `targets` there. Deferred to here — NOT right after the
  // build lock — on purpose: the recorder writes to a database, so the mint
  // must land after waitForPg above, or a cold manual build would race
  // Postgres startup. The row is closed once every target has deployed,
  // which is what keeps the UI's "Building…" spinner honest.
  if (!uiTriggered) {
    const claim = await recorder.insertRun({
      id: buildId,
      targets: targets.map((t) => t.composition),
      trigger: "manual",
      // `headAtStart`, the full sha: the same one stamped into the dist as
      // `.build-commit` and onto the receipt, so the ledger row and the
      // pin name the same commit in the same spelling by construction —
      // which is what lets the convergence decision compare them at all.
      commitHash: headAtStart,
      pid: process.pid,
    });
    if (claim === "lost") {
      // "lost" now means a LIVE build holds the slot: a holder whose build
      // already ended was settled from its own build-logs record and the claim
      // retried inside `insertRun`.
      softNotes.push(
        `build-runs: a live build of ${name} holds the slot — no ledger row minted`,
      );
    } else if (claim === "unavailable") {
      // No ledger to write to — either no database at all (a checkout that has
      // never been deployed, which a composition-only build legitimately
      // reaches), or a database whose `build_runs` table this build has not
      // created yet (the machine's very first build). Either way it is a note,
      // never a failure: nothing about the deploy depends on it.
      softNotes.push(
        `build-runs: no ledger in ${name} yet — this build is not recorded`,
      );
    }
  }

  // Stage 2 — DB migrations + manifest-level codegen + the mandatory
  // config-override seed. Runs AFTER the DB interlude above (drizzle's
  // generate is stateful) and BEFORE propagation below, which reads the
  // freshly-seeded git layer. May terminate the process on a migration
  // prompt (exit 2) — unchanged. See ./internal/app-artifacts.ts.
  await generateAppSources({
    root,
    migration: {
      name: opts.migrationName,
      reset: opts.resetMigration,
      custom: opts.customMigration,
      answers: opts.migrationAnswers
        ? parseMigrationAnswers(opts.migrationAnswers)
        : undefined,
    },
    hooks,
  });

  // 4b'. Every generated artifact has now been re-derived from this tree's
  //      sources, so any merge marker a rebase left behind is answered — a
  //      build normalizes by construction rather than by marker. Consuming
  //      them here (and never earlier: a build that dies mid-codegen must
  //      leave the signal intact) is what keeps the
  //      `generated-artifacts-normalized` check from firing after a build
  //      has already done the repair.
  clearMergeMarkers(root);

  // 4b''. THE LAST WRITER TO THE REPO TREE. Every generated artifact above
  //       is already in its final byte form (writeGenerated), so this pass
  //       covers hand-written source, scoped to this branch's diff vs main.
  //
  //       The position is load-bearing, not incidental: it must run after
  //       ALL codegen writes and before anything hashes the tree. The check
  //       cache keys a PASS on the whole working-tree hash (see
  //       `checks/core/read-set.ts` — "ONE changed byte anywhere re-runs all
  //       ~62 checks") and web-artifact store keys are the plugin's own
  //       source bytes (`web-artifacts/core/hash.ts`, fingerprinted on
  //       `(mtimeMs, size)`). A formatter running after either would
  //       invalidate both on the NEXT build, every build.
  //
  //       Runs regardless of `--skip-checks`: it is not validation.
  endSpan = buildProfilerStart(
    "formatSources",
    "build:codegen",
    "format changed sources",
  );
  const formatPass = await formatChangedSources({
    root,
    log: (l) => console.log(l),
  });
  if (formatPass.formatted.length > 0) {
    console.log(`Formatted ${formatPass.formatted.length} file(s):`);
    for (const f of formatPass.formatted) console.log(`  ${f}`);
  }
  endSpan();

  // 4b'''. Every writer to the repo tree has run. On main none of them may
  //        have changed a path git sees — ./internal/main-tree-guard.ts.
  if (mainTreeBefore !== null) {
    endSpan = buildProfilerStart(
      "mainTreeGuard",
      "build:codegen",
      "main tree untouched",
    );
    await assertMainTreeUntouched(root, mainTreeBefore);
    endSpan();
  }

  // 4c. Config propagation is PER TARGET now — each namespace gets its own
  //     `~/.singularity/state/config/<namespace>/` — so it lives inside
  //     `deployNamespace` rather than here. It still runs after the
  //     freshly-seeded git layer above, because every target's deploy does.

  // 3c–5. Run validation (checks) and the frontend build in parallel, then
  // publish — the shared app-artifact pipeline's stage 3
  // (./internal/app-artifacts.ts). They are independent: checks read source
  // files, the frontend compiles into a staging dir. On failure the staging
  // dir is cleaned up and nothing is published.
  // The `typescript` check type-checks every target (including the runtime
  // entrypoints), so we no longer run separate runtime tsc passes here — that
  // double-checked cli/server-core/central-core on every build. With
  // `--skip-checks` the check doesn't run, so `fastValidationJobs` still
  // guards server type-safety with a single incremental tsc over the runtime
  // entrypoints.
  //
  // (`lane` is derived once, up-front, next to the op record it also feeds.)
  // Publish the lane from the same fact BEFORE the check pass is spawned
  // below — the child is exactly the inheriting subprocess this exists for,
  // and it classifies itself from what it reads here. See ../lane.ts.
  publishLane(branch === "main");
  // A background-lane build additionally runs its heavy children (vite, the
  // server bundle) darwinbg-demoted so even a single build can't starve the
  // interactive main backend (one build legitimately fans across every core).
  // Usually redundant — a build started from an agent's tmux session already
  // inherits darwinbg — but it keeps the invariant when an agent branch is
  // built from an undemoted shell. Derived from the LANE, the same fact the
  // grant carries, never re-derived from the branch: the type-check worker
  // reads `grant.lane` at its one spawn site (type-check/server), so the two
  // cannot disagree.
  const backgroundBuild = lane === "background";

  // The FULL checks pass stays HERE rather than moving into the shared
  // pipeline: it is build-specific observability — the untruncated
  // check transcript plus a per-check `pushBuildSpan` that draws the build
  // Gantt's `build:checks` lane. Validation is not artifact production, so
  // stage 3 takes it as a companion job sharing its ONE host grant.
  const fullChecksJob: HeavyJob = async (grant) => {
    const start = performance.now();
    // SPAWNED, never called in-process — see ../check-subprocess.ts. This
    // process has already imported every plugin barrel and run the
    // slot-declaration pass, so a check running here would record a global
    // cache entry no standalone check could reproduce, and a later push
    // would read it back as its own verdict.
    //
    // Build asserts exactly two scopes: the TREE it built from, and the DEPLOY
    // it just produced — it is the one caller that can claim the latter, being
    // the process that produces the dist those checks inspect.
    //
    // It does NOT assert `host`. That scope is about the machine: the shared
    // `~/.singularity` data root, which every checkout on the box writes to and
    // which runs ahead of any one branch. A build observing it sees state some
    // other live worktree created — state it did not cause and cannot repair.
    // This used to be spelled as NO filter at all, which is a different claim
    // ("every scope, including any added later") and is how a build came to fail
    // on a data dir a concurrently-running agent's unmerged branch had declared.
    const result = await runCheckSubprocess({
      root,
      select: { scope: ["tree", "deploy"] },
      // The build's host CPU grant — the child's type-check spends it per
      // worker, without re-acquiring host-wide.
      grant,
      // The child derives `check-<buildId>.log` from this — the identical
      // path this build's failure funnel points at, because both sides
      // compute it from `basename(root)`. Full, untruncated check output
      // lands there beside the build's other per-run artifacts; the
      // captured `lines` (console + build.log) stay summarized.
      runId: buildId,
      output: "capture",
    });
    // Replayed from the child's own settle records, reconciled onto this
    // process's clock — so `build:checks` still draws one bar per check at
    // its true offset. A killed child draws a partial lane, which is honest
    // and strictly better than the in-process pass it replaces, which drew
    // nothing at all when interrupted.
    for (const span of result.spans) {
      pushBuildSpan(
        `check:${span.checkId}`,
        "build:checks",
        span.checkId,
        span.durationMs,
        span.wallStartMs,
      );
    }
    // New information the in-process pass could not produce: the check
    // fleet used to run inside this process, where it was invisible in the
    // orchestrator's own `getrusage(RUSAGE_SELF)` peak. Now it is a child
    // with a footprint of its own, measured like every other heavy child.
    recordFootprint("checks", result.maxRssBytes);
    return {
      // `id: "checks"` is load-bearing — the build's failure funnel keys on
      // it to add the check-log pointer.
      id: "checks",
      label: "checks",
      lines: result.lines,
      durationMs: Math.round(performance.now() - start),
      success: result.ok,
    };
  };

  // The `--skip-checks` validation set (always-run checks + one incremental
  // tsc per runtime entrypoint) is shared with the hermetic caller, so
  // neither can drift on what a fast artifact build still proves.
  const companions: HeavyJob[] = opts.skipChecks
    ? await fastValidationJobs({
        root,
        checkRunId: buildId,
        hooks,
      })
    : [fullChecksJob];

  // Duress admission valve: a background-lane build is held BEFORE it
  // queues for the host grant while the host duress latch is fresh, so no
  // new heavy work starts into a memory/congestion storm. Interactive
  // (main), push, and the detached auto-build are never held. The hold /
  // post-acquire requeue loop itself lives in stage 3 — see
  // ./internal/app-artifacts.ts, ../admission-valve.ts and
  // research/2026-07-11-global-fleet-memory-admission-duress-valve.md.
  const gated = valveGates(lane, process.env);

  // Drive the `duress-valve` wait off the valve's OWN hold bracket — the
  // same seam the `duressHold` span already hangs on, so the record and the
  // span can never disagree about how long the hold was. Deps are built once
  // rather than per `holdThroughValve` call (holds never nest, which is the
  // invariant `createValveDeps`'s single span slot already relies on).
  const baseValveDeps = createValveDeps();
  const valveDeps: ValveDeps = {
    ...baseValveDeps,
    // The latch's trip reason and how the hold ended (cleared / fail-open)
    // ride on the wait itself, so a surface can say WHY a build is held.
    onHoldStart: (reason) => {
      baseValveDeps.onHoldStart(reason);
      profiler.waitStart("duress-valve", reason);
    },
    onHoldEnd: (outcome) => {
      baseValveDeps.onHoldEnd(outcome);
      profiler.waitEnd(outcome);
    },
  };

  // A gated build whose machine watcher is not running cannot be held, so it
  // says so now and again in its OK headline — the line an agent reads.
  const guardNote = checkValveGuard({ gated }, valveDeps);
  if (guardNote !== null) softNotes.push(guardNote);

  // The transcript, the step roster and the profile are ONE per invocation,
  // so `stepResults` is refreshed by whichever target is currently in stage
  // 3 and the verdict's roster names that target's steps — the failing one
  // on a failure, the last one on success. Every target's steps are pushed
  // into the shared step log, so the transcript carries all of them in
  // order.
  let stepResults: StepResult[] = [];
  const onSteps = (steps: StepResult[]): void => {
    stepResults = steps;
    for (const result of steps) pushBuildStepLog(result);
    printStepBlocks(steps);
  };

  const stepRoster = (): Verdict["steps"] =>
    stepResults.map((r) => ({ label: r.label, success: r.success }));

  /**
   * The commit this checkout moved to during the build, or `null` if it did
   * not move. Non-null means the tree this build was reading was replaced
   * under it — so nothing it concluded is about a single coherent tree, and
   * a failing verdict in particular says nothing about either commit.
   */
  const supersededBy = async (): Promise<string | null> => {
    if (headAtStart === null) return null;
    const head = await readHead(root);
    return head !== null && head !== headAtStart ? head : null;
  };

  // How far the fan-out got, for a verdict that has to be honest about a
  // partial deploy. `deployedIndex` is the index of the target currently
  // being deployed (-1 before the loop), so everything after it was never
  // attempted.
  const deployedUrls: string[] = [];
  let deployingIndex = -1;

  // The single fatal funnel. Every post-steps failure routes through here so
  // the build's own verdict — with the failing step last, the full step
  // roster, the NOT DEPLOYED consequence, and the log pointers as the literal
  // last lines — is the terminal output on both console and build.log. The
  // verdict's pointers name build.log's own path, so that path is computed
  // (pure helper) and the verdict rendered BEFORE build.log is written.
  const failBuild = async (
    reason: string[],
    failedLabels: string[],
  ): Promise<never> => {
    flushFootprint();
    const buildLogPath = worktreeArtifacts.buildLogText(name, buildId);
    const pointers = [`Full output: ${buildLogPath}`];
    // One receipt pointer per namespace this invocation opened — the file
    // that answers "did MY app land?" for each of them.
    for (const ns of receipts.keys()) {
      pointers.push(`Deploy receipt: ${worktreeArtifacts.buildStatus(ns)}`);
    }
    if (stepResults.some((r) => r.id === "checks" && !r.success)) {
      pointers.push(
        `Check logs:  ${worktreeArtifacts.checkLog(name, buildId)}`,
      );
    }
    // What a multi-target invocation owes its reader, in the same shape
    // `hermetic-build.ts` reports it: fail-fast means everything already
    // published stays published, and everything after the failure was never
    // attempted. Silent on a single-target build, where both are empty.
    const notAttempted = targets
      .slice(deployingIndex + 1)
      .map((t) => t.namespace);
    const fanOut = [
      ...(deployedUrls.length > 0
        ? [`Already deployed: ${deployedUrls.join(", ")} (left in place).`]
        : []),
      ...(notAttempted.length > 0
        ? [`Not attempted: ${notAttempted.join(", ")}.`]
        : []),
    ];
    // Asked here, at the ONE funnel every failure routes through, so no
    // failure path can forget to ask. A build whose tree was replaced mid-run
    // has no subject: reporting it as a failure blames whichever check
    // happened to straddle the swap for drift that does not exist.
    const newHead = await supersededBy();
    const v: Verdict =
      newHead !== null
        ? {
            ok: false,
            headline: `BUILD SUPERSEDED — ${headAtStart!.slice(0, 9)} → ${newHead.slice(0, 9)}`,
            reason: [
              `NOT DEPLOYED. ${targetUrls.join(", ")} still ${targetUrls.length === 1 ? "serves its" : "serve their"} previous build.`,
              `This checkout moved to ${newHead.slice(0, 9)} while the build was reading it, so`,
              `the steps below straddle two different trees and their verdict is void —`,
              `${failedLabels.length > 0 ? failedLabels.join(", ") : "the failure"} above is NOT a real failure.`,
              `A build of ${newHead.slice(0, 9)} follows automatically.`,
              ...fanOut,
            ],
            pointers,
            steps: stepRoster(),
          }
        : {
            ok: false,
            headline: `BUILD FAILED — ${failedLabels.length > 0 ? failedLabels.join(", ") : "deploy"}`,
            reason: [...reason, ...fanOut],
            pointers,
            steps: stepRoster(),
          };
    // The one code this failure ends on. Resolved here rather than beside
    // closeRun below so the artifact, the ledger row and the receipts are
    // all stamped from the same value and cannot disagree.
    const exitCode = newHead !== null ? BUILD_EXIT_SUPERSEDED : 1;
    writeBuildLogs(name, renderVerdict(v), exitCode);
    // Close this invocation's build_runs row, BEFORE finalizeBuild releases
    // the recorder pool. One row, one exit code — honest, because the
    // invocation is the unit of work even when several namespaces published.
    await recorder.closeRun(buildId, exitCode);
    // `superseded` is its own receipt status, not a flavour of `failed`:
    // the tree moved mid-build, so this build answers for no coherent tree —
    // reporting it as a failure would blame the check that straddled the swap.
    await finalizeBuild(false, {
      status: newHead !== null ? "superseded" : "failed",
      exitCode,
    });
    emitVerdict(v);
    process.exit(exitCode);
  };

  const buildOkVerdict = (): Verdict => ({
    ok: true,
    headline:
      softNotes.length > 0
        ? `BUILD OK — deployed (${softNotes.join("; ")})`
        : "BUILD OK — deployed",
    notes: deployedUrls,
    pointers: [...receipts.keys()].map(
      (ns) => `Deploy receipt: ${worktreeArtifacts.buildStatus(ns)}`,
    ),
    steps: stepRoster(),
  });

  // ── The fan-out: one deploy per target, FAIL-FAST ────────────────────
  //
  // Everything above this line was a function of the SOURCE TREE and ran
  // once; everything inside is a function of one (composition, checkout)
  // pair. The first failure ends the invocation — compositions in one build
  // share a plugin union, so a second failure is almost always the same
  // failure re-derived at ~10 min a go, and what already published stays
  // published (which the verdict says).
  for (const [i, target] of targets.entries()) {
    deployingIndex = i;
    // Namespaces are the only thing separating N otherwise identical step
    // blocks in the transcript.
    if (targets.length > 1) {
      console.log(
        `\n── ${target.namespace} (${i + 1}/${targets.length}) ──────────────`,
      );
    }
    openReceipt(target.namespace);
    const deployed = await deployNamespace({
      target,
      root,
      webDir,
      buildId,
      commit: headAtStart,
      checkout,
      minify: opts.minify,
      // The red frame marks an agent-worktree deploy, and that is a fact
      // about the CHECKOUT, not about the composition — so every namespace
      // a worktree publishes carries it, and main's publishes none.
      experimental: checkout.kind === "worktree",
      lane,
      background: backgroundBuild,
      // Validation belongs to the SOURCE TREE, which every target shares,
      // so it runs with the first target only — early enough that a broken
      // tree fails before burning N artifact builds, and once rather than N
      // times. Reads like a bug at a glance; it is the opposite, and it is
      // exactly what `hermetic-build.ts` does.
      companions: i === 0 ? companions : [],
      admission: {
        gated,
        deps: valveDeps,
        grantHooks: profiler.grantHooks(),
        onRequeue: () => profiler.requeue(),
      },
      restart: opts.restart,
      onSteps,
      hooks,
    });
    if (!deployed.ok) {
      return await failBuild(deployed.reason, deployed.failedLabels);
    }
    softNotes.push(...deployed.notes);
    // This namespace IS deployed. Its receipt is stamped terminal NOW rather
    // than at finalizeBuild, so a later target's failure — or a kill — can
    // never rewrite a published namespace's receipt as `failed`.
    closeReceipt(target.namespace, "ok", 0);
    deployedUrls.push(namespaceUrl(target.namespace));
  }

  // 6c. Re-register the `central` worktree spec for idempotency. Path is
  // always main's central-core/ — see comment at the early write above.
  //
  // Invocation-scoped, so it sits OUTSIDE the loop: central is a singleton
  // API runtime shared by every namespace, and restarting it once per
  // target would drop every WS connection N times. After the loop rather
  // than before it, because the alternative is worse: central runs main's
  // code, so restarting it early would leave the live app on its old dist
  // talking to a new central for the whole ~10-minute heavy section. Here
  // the only cost is that the backends just restarted above reconnect once
  // — which the networking primitive does on its own.
  if (existsSync(join(centralDir, "bin", "index.ts"))) {
    // No `composition` — see the early central write above.
    writeWorktreeSpec({ name: "central", server: centralDir });

    // 6d. Restart central so it picks up freshly-merged main code. Only
    // done when building from main — agent worktrees never change central's
    // running code (central always runs main's central-core/), so restarting on
    // every worktree build would needlessly drop every open WS connection.
    if (root === mainRoot) {
      endSpan = buildProfilerStart(
        "restartCentral",
        "build:deploy",
        "restart central",
      );
      console.log("Restarting central...");
      try {
        const resp = await fetch(
          "http://localhost:9000/gateway/worktrees/central/restart",
          { method: "POST", signal: AbortSignal.timeout(30_000) },
        );
        if (resp.ok) {
          const gwNote = await probeGatewayHealth();
          if (gwNote) softNotes.push(gwNote);
        } else if (resp.status !== 404) {
          console.warn(`Central restart returned ${resp.status}`);
        }
        // eslint-disable-next-line promise-safety/no-bare-catch
      } catch {
        // Gateway not running — central will spawn fresh on first request.
      }
      endSpan();
    }
  }

  // A build that PASSED across a mid-run tree swap still deployed artifacts
  // assembled from two trees, so it is deployed-but-not-current rather than
  // wrong-and-loud. Say so instead of claiming a clean deploy of either
  // commit; `convergeMain` rebuilds from the tip regardless, and it compares
  // against the commit this build STARTED on precisely because
  // `.build-commit` records the post-swap head and would look current.
  const okHead = await supersededBy();
  if (okHead !== null)
    softNotes.push(
      `superseded — main moved to ${okHead.slice(0, 9)} mid-build, rebuild follows`,
    );

  // Every target published and (when the gateway is up) verified healthy —
  // close the invocation's one build_runs row. This is the spinner fix: the
  // row must not outlive the work it describes.
  await recorder.closeRun(buildId, 0);

  flushFootprint();
  writeBuildProfile(name);
  const okV = buildOkVerdict();
  writeBuildLogs(name, renderVerdict(okV), 0);
  await finalizeBuild(true);
  emitVerdict(okV);
};

export default run;

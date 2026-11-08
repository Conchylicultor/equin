import {
  asAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  envEntries,
  readEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { realpathSync } from "@plugins/packages/plugins/timed-fs/core";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import {
  checkBroadcasts,
  installFatalSignalExit,
  opPriority,
  reportInterruptedPredecessorSync,
  signalOriginTap,
} from "@plugins/framework/plugins/cli/plugins/op-runtime/cli";
import { normalizeGeneratedArtifacts } from "@plugins/framework/plugins/cli/plugins/git-artifacts/cli";
import {
  createOpProfiler,
  type OpProfiler,
} from "@plugins/debug/plugins/profiling/plugins/op-log/server";
import {
  pushPool,
  repoPushLock,
  withHostGrant,
} from "@plugins/infra/plugins/host/plugins/host-admission/server";
import {
  cpuBudget,
  type Grant,
  type Priority,
} from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { markWorktreeOpStart } from "@plugins/infra/plugins/worktree/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  describeAutoIdentity,
  describePublishTarget,
  ensureCommitIdentity,
  resolvePublishTarget,
} from "@plugins/infra/plugins/git/plugins/remotes/core";
import { withTreeWrite } from "@plugins/infra/plugins/git/plugins/tree-lock/core";
import {
  actAsCheckoutNamespace,
  checkoutRef,
  worktreeArtifacts,
} from "@plugins/infra/plugins/paths/server";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import {
  resolvePushAttribution,
  trailerAmendCommand,
  trailerArgs,
} from "./attribution";
import {
  exec,
  getMainWorktree,
  getWorktreeRoot,
  GIT_TIMEOUT_MS,
  run,
  runAllowFail,
} from "./git";
import { runLandPhase, takeLandPayload } from "./handoff";
import { resolveFixedReports } from "@plugins/reports/plugins/engine/cli";
import { landPush } from "./land";

// The three facts that decide HOW this branch is made to land on main.
interface LandingShape {
  /** Commits in `main..HEAD` — what this push actually contributes. */
  commits: number;
  /** How many of them are merge commits. */
  merges: number;
  /** Is `main` already an ancestor of HEAD? */
  containsMain: boolean;
}

// `git merge-base --is-ancestor` answers in its exit code: 0 yes, 1 no.
// Anything else is git FAILING rather than answering, and reading that as "no"
// would silently flatten a merge — so it exits like every other failed git call
// in this file.
async function branchContainsMain(): Promise<boolean> {
  const cmd = ["git", "merge-base", "--is-ancestor", "main", "HEAD"];
  const result = await spawnCaptured(cmd, { timeoutMs: GIT_TIMEOUT_MS });
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  console.error(`Command failed (exit ${result.exitCode}): ${cmd.join(" ")}`);
  if (result.stderr.trim()) console.error(result.stderr.trim());
  process.exit(1);
}

async function readLandingShape(): Promise<LandingShape> {
  const containsMain = await branchContainsMain();
  const counted = Number(
    await run(["git", "rev-list", "--count", "main..HEAD"]),
  );
  if (!Number.isInteger(counted)) {
    console.error("Could not count the commits this push would land.");
    process.exit(1);
  }
  const merges = (await run(["git", "rev-list", "--merges", "main..HEAD"]))
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
  return { commits: counted, merges, containsMain };
}

// Env for THIS push's own rebases. The `post-rewrite` hook normalizes generated
// artifacts after any other rebase; push suppresses it because it owns the
// ordering itself — its land phase installs the rebased lockfile FIRST (in its
// own bootstrap), then normalizes, so the regen runs against node_modules that
// match the tree it is regenerating.
const rebaseEnv = (): Record<string, string | undefined> => ({
  ...process.env,
  ...envEntries({ SKIP_POST_REWRITE: "1" }),
});

const nulList = (out: string): string[] => out.split("\0").filter(Boolean);

// Refuse, before anything reaches the remote, when the main checkout holds a
// local change on a path this push's fast-forward will rewrite. Left to git, the
// collision surfaces as a bare "Your local changes … would be overwritten by
// merge" abort at the LAST step — after the branch was already pushed — and
// looks like this push's failure. It is not: main's checkout is nobody's
// workspace, so a change there is a stray (e.g. a build that wrote a tracked
// file — main's build now fails rather than doing so, see build's
// `main-tree-guard.ts`).
//
// Only a COLLISION refuses, not any dirt: a change on a path the merge does not
// touch never blocked a push and still doesn't. `target` is what main will
// fast-forward to before the branch lands (`<remote>/main` once fetched, or
// main itself in local mode); the merge touches every path that differs from
// main's HEAD to it, plus every path the branch changes from it.
async function assertNoMainCollision(
  mainWorktree: string,
  target: string,
  branch: string,
): Promise<void> {
  const dirty = new Set([
    ...nulList(
      await run(["git", "diff", "--name-only", "-z", "HEAD"], mainWorktree),
    ),
    ...nulList(
      await run(
        ["git", "ls-files", "--others", "--exclude-standard", "-z"],
        mainWorktree,
      ),
    ),
  ]);
  if (dirty.size === 0) return;
  const touched = new Set([
    ...nulList(
      await run(
        ["git", "diff", "--name-only", "-z", "HEAD", target],
        mainWorktree,
      ),
    ),
    ...nulList(
      await run(
        ["git", "diff", "--name-only", "-z", `${target}...${branch}`],
        mainWorktree,
      ),
    ),
  ]);
  const collisions = [...dirty].filter((p) => touched.has(p)).sort();
  if (collisions.length === 0) return;
  console.error(
    [
      `ERROR: the main checkout (${mainWorktree}) has local changes on paths this`,
      "push would merge, so the merge into main would abort. Nothing was pushed.",
      "",
      ...collisions.map((p) => `  ${p}`),
      "",
      "These changes were not made by this push. Agents must not edit or clean the",
      "main checkout: STOP and report this to the user. If they are generated files,",
      "main's last auto-build is the likely writer — its failed run names the stray",
      "input.",
    ].join("\n"),
  );
  process.exit(1);
}

/**
 * Refuse to land on a `main` that is not this checkout's own repository's.
 *
 * Every step after this writes to `mainWorktree`, and nothing about it is
 * reversible once `main` has advanced (or been pushed). By construction it is
 * the first worktree listed for the checkout push was run from, but
 * an inherited `GIT_DIR` / `GIT_WORK_TREE` / `GIT_COMMON_DIR` — or any future
 * resolver that stops deriving it from `root` — would silently point it at a
 * different repository: a test's temp clone landing on the real `main`, or the
 * reverse. So the two are compared by git's own identity for a repository, the
 * common dir, and a push that would cross repositories stops before the lock.
 */
async function assertLandsOnOwnRepository(
  root: AppPath,
  mainWorktree: AppPath,
): Promise<AppPath> {
  const inherited = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"].filter(
    (name) => process.env[name] !== undefined,
  );
  if (inherited.length > 0) {
    console.error(
      `Refusing to push: ${inherited.join(", ")} set in the environment would ` +
        `redirect git away from the checkout this push was run from (${root}). Unset it and re-run.`,
    );
    process.exit(1);
  }
  const commonDir = (cwd: string) =>
    run(
      ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
      cwd,
    ).then((dir) => realpathSync(dir));
  const [ours, target] = await Promise.all([
    commonDir(root),
    commonDir(mainWorktree),
  ]);
  if (ours !== target) {
    console.error(
      `Refusing to push: the main worktree resolved to ${mainWorktree} (repository ${target}), ` +
        `which is not the repository of this checkout (${ours}).`,
    );
    process.exit(1);
  }
  return asAppPath(ours);
}

async function getCurrentBranch(): Promise<string> {
  const { stdout, exitCode } = await runAllowFail([
    "git",
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  if (exitCode !== 0 || !stdout) {
    console.error("Could not determine current branch");
    process.exit(1);
  }
  return stdout;
}

type PushLock = Pick<typeof pushPool, "run">;

/**
 * The mutex a push of this repository takes. What it serializes is writes to ONE
 * repository's `main`, so its scope is that repository:
 *
 * - the repository this machine's main app is served from (its main checkout is
 *   `checkoutRef` "main") takes the host-wide `push` pool below — the one every
 *   agent's push, the op log and the Debug views know;
 * - any other repository (a second clone, an e2e's temp repo) locks inside its
 *   own git dir, so its push — check pass and all — never queues the machine's
 *   real pushes behind it, nor waits behind them.
 */
async function pushLockFor(
  mainWorktree: AppPath,
  gitCommonDir: AppPath,
): Promise<PushLock> {
  if ((await checkoutRef(mainWorktree)).kind === "main") return pushPool;
  return repoPushLock(gitCommonDir);
}

// The push mutex is the `push` host-pool (host-admission): `pushPool.run(fn)`
// holds its single slot file — `~/.equin/locks/push/slot-0.lock` — for the
// whole critical section, so at most one push runs host-wide. Who holds it and
// who queues on it is read from the op log (`push-mutex` waits, `granted`). This folds the last hand-rolled
// FFI flock onto the shared primitive: the size-1 fan-out is a single
// `flock-wait` child (off the event loop), and the "waiting for lock" line moves
// to the pool's `onWaitStart` hook. `onLockRequested` fires before the acquire
// (so a blocked push shows as waiting); `onLockAcquired` fires once the slot is
// held, as the first thing inside the run body.
//
// **The critical section is ONE interactive host grant.** Every queued push
// waits on whoever holds the mutex, so the holder is human-blocking for its
// whole hold — not only while its checks run. The grant is taken as the first
// thing inside the mutex and `fn` receives it: the rebase, then the land phase
// (install, normalize, checks, merge — a child handed the grant) all run under
// it, so they are admitted
// CPU and — the interactive lane's other half (`withHostGrant`) — run in the
// foreground instead of at the agent session's inherited darwinbg tier. Taken
// only around the checks, everything else in the hold ran on the E-cores beside
// the whole fleet: normalize is ~13 s of work that took a median 109 s (p90
// 255 s) there (research/2026-10-15-global-push-lock-holder-foreground.md).
// Mutex then grant is acyclic: a grant holder never waits for the push mutex.
// `grantHooks()` lands the grant queue as its own `host-grant` wait, right after
// `granted`, rather than inside any step.
//
// **`priority` orders the MUTEX queue, never the grant.** A sidequest push
// (`low`) takes the mutex only while no main-track push is waiting for it, so a
// main push never queues behind a sidequest one that arrived first. Once a push
// HOLDS the mutex, every queued push waits on it — so its grant is `normal`
// whatever its track: a holder yielding CPU to others would only stretch the
// hold the main-track pushes behind it are waiting out.
async function withPushLock<T>(
  lock: PushLock,
  priority: Priority,
  profiler: OpProfiler<"push">,
  fn: (grant: Grant) => Promise<T>,
  onLockRequested: () => void,
  onLockAcquired: () => void,
): Promise<T> {
  onLockRequested();
  return lock.run(
    async () => {
      onLockAcquired();
      return await withHostGrant(
        {
          lane: "interactive",
          priority: "normal",
          max: cpuBudget().B,
          hooks: profiler.grantHooks(),
        },
        fn,
      );
    },
    {
      priority,
      onWaitStart: () =>
        console.log("Another push is in progress — waiting for lock..."),
    },
  );
}

// After the rebase, the driver's only work: run the land phase on the rebased
// code inside this mutex and grant, record what it reports, and end the op the
// way it ended. A failed phase printed its own story; this exits with its code.
async function handOff(
  root: AppPath,
  opSlug: Namespace,
  pushId: string,
  mode: "worktree" | "from-main",
  grant: Grant,
  profiler: OpProfiler<"push">,
): Promise<void> {
  const result = await runLandPhase({
    root,
    pushId,
    mode,
    reportPath: worktreeArtifacts.pushLand(opSlug, pushId),
    grant,
    profiler,
  });
  if (result.kind === "success") return;
  profiler.complete(result.kind);
  profiler.write();
  process.exit(result.exitCode);
}

const pushAction: CliAction<
  [],
  {
    message?: string;
    fromMain?: boolean;
    unattributed?: string;
    fixesReport?: string[];
  }
> = async (opts) => {
  // This process is the land phase of a push its parent drives: the steps
  // after that push's rebase, on the rebased code (./handoff.ts).
  const landing = takeLandPayload();
  if (landing !== undefined) return landPush(landing);

  const branch = await getCurrentBranch();
  const onMain = branch === "main";

  await checkBroadcasts("push");

  const root0 = await getWorktreeRoot();

  // One push id per invocation; every commit that lands on main as part of
  // this push gets stamped with it (via `git commit --trailer` for the
  // --from-main path, and via `git rebase --exec` for the worktree path).
  // Watchers on every namespace read the trailer to group commits into a
  // single push event.
  const pushId = crypto.randomUUID();

  if (onMain && !opts.fromMain) {
    console.error("Already on main — nothing to merge.");
    process.exit(1);
  }
  if (opts.fromMain && !onMain) {
    console.error(
      `--from-main requires being on main (currently on ${branch}).`,
    );
    process.exit(1);
  }

  // Who this push credits: the trailers stamped beside the push trailer on
  // every commit it lands (the attempt its branch names, or an explicit
  // `--unattributed` reason). Decided once, before anything is written, so a
  // refused `--unattributed` leaves nothing half-done. See ./attribution.ts.
  const attribution = resolvePushAttribution({
    branch,
    pushId,
    conversationId: readEnv("CONVERSATION_ID"),
    unattributed: opts.unattributed,
  });
  if (!attribution.ok) {
    console.error(attribution.message);
    process.exit(1);
  }
  // The reports this push fixes (`--fixes-report`), checked against main's
  // reports before anything is written; one more trailer on every commit.
  const fixed = await resolveFixedReports({
    ids: opts.fixesReport ?? [],
    message: opts.message,
  });
  if (!fixed.ok) {
    console.error(fixed.message);
    process.exit(1);
  }
  const landingTrailers =
    fixed.trailer === null
      ? attribution.trailers
      : [...attribution.trailers, fixed.trailer];

  // May this checkout publish at all? Asked ONCE, here — before the push
  // mutex, so a cold-cache probe's round trip is not paid while holding a
  // host-wide lock, and before the commit below, which needs the answer (see
  // its trailer case).
  //
  // Local `main` is the trunk either way: everything offline — the lock, the
  // rebase onto main, the install, the normalize, the checks, the
  // fast-forward — runs identically. What the answer gates is only the three
  // steps that touch the network. A checkout that may not publish is not a
  // broken one; it is the ordinary state of a clone.
  const publish = await resolvePublishTarget(root0);
  if (publish.kind === "local") {
    // Printed for the local arm only: for a publisher nothing has changed, and
    // a line saying so would be noise on every push. This is the one place the
    // difference is announced, so it is never silent.
    console.log(describePublishTarget(publish));
  }

  // Who signs this push's commits — the one below and every commit the
  // rebase's trailer `--exec` rewrites. Decided now, from the answer above:
  // a clone that cannot publish gets a local placeholder silently, a checkout
  // whose commits will be public must have a real identity. Refused here,
  // before the mutex, the commit or any network step, so nothing is half-done.
  const identity = await ensureCommitIdentity(root0, publish);
  if (identity.kind === "refuse") {
    console.error(identity.message);
    process.exit(1);
  }
  if (identity.kind === "auto" && identity.written)
    console.log(describeAutoIdentity(identity));

  // The op-marker slug (see markWorktreeOpStart below) is this checkout's own
  // namespace — `push` names the main composition, as `build` does. The
  // profiler carries it so the orphan reconciler can check push liveness.
  const opSlug = await actAsCheckoutNamespace(root0);

  // An interrupted build prints no verdict and sets no exit code its caller
  // can see, so the next op is where it surfaces — and pushing work that was
  // never actually deployed is the expensive version of that mistake.
  reportInterruptedPredecessorSync(opSlug);
  // A push is human-blocking, so every grant it takes is interactive — the
  // same fact `runRebasedChecks` passes to `withHostGrant`. Recorded on the
  // op because the lane is what explains WHY a wait was as long as it was.
  const profiler = createOpProfiler("push", {
    opId: pushId,
    branch,
    opSlug,
    lane: "interactive",
    mode: opts.fromMain ? "from-main" : "worktree",
  });

  // This push's liveness marker (see worktree-op.ts): a flocked
  // `ops/<pushId>.json`, held for the process's life — BEFORE the lock wait,
  // so a push queued behind another reads as "working" (a queued push is
  // genuinely in progress), and before `requested`, so the op log never holds
  // a push no marker vouches for. Released on every graceful exit — normal
  // completion, every process.exit(1) failure path, thrown errors — by the
  // exit handler, AFTER the terminal is appended. A SIGKILLed push drops the
  // lock with the process, and the op-store reconciler closes it.
  const marker = markWorktreeOpStart(opSlug, "push", pushId);
  // A sidequest checkout's push yields the push mutex to waiting main-track
  // pushes (see withPushLock). Asked before the mutex, never while holding it.
  const priority = await opPriority(root0, "push", onMain);
  // Set once the push contends for the mutex: a push that fails before that
  // point writes no op record at all — it never contended for anything.
  let requested = false;
  process.on("exit", () => {
    // The terminal (idempotent — a path that already wrote one keeps it; one
    // that exits without an outcome lands as "error"), THEN the release.
    if (requested) profiler.write();
    marker.release();
  });

  // Catchable fatal signals → graceful exit so the exit handler above runs —
  // e.g. the wrapper's orphan SIGTERM tears this worker down cleanly. SIGKILL
  // is uncatchable; the kernel drops the marker's lock with the process. The
  // signal→exit-code map is shared with `build` and `check`; see
  // ../fatal-signals.ts.
  //
  // The tap arms here too, and the sink is this command's ONLY record of a
  // death — a push owns no deploy receipt. It is also the op where an
  // unattributed death costs the most: a push holds the host-wide push
  // mutex, so every agent on the box queues behind whoever killed it.
  installFatalSignalExit(
    await signalOriginTap({ opId: pushId, worktree: opSlug }),
  );
  // Fires immediately BEFORE `pushPool.run` (see withPushLock), so a push
  // blocked on the mutex lands on disk as a live "waiting" row before it
  // ever holds the lock. A failure BEFORE this point writes no record at
  // all — it never contended for anything.
  const onLockRequested = (): void => {
    requested = true;
    profiler.markRequested();
    profiler.waitStart("push-mutex");
  };
  const onLockAcquired = (): void => {
    // The mutex — this push's ENTRY ticket — is held and its own work
    // starts. It is not done waiting: `withPushLock` next queues for the
    // section's interactive host grant, which lands as a further `host-grant`
    // wait before the first step.
    profiler.waitEnd();
    profiler.markGranted();
  };

  // 1. Commit if -m provided, otherwise require clean tree
  const status = await run(["git", "status", "--porcelain"]);
  if (opts.message) {
    if (status) {
      const files = status.split("\n").map((l) => l.trim());
      console.log(
        `Committing ${files.length} file(s)${opts.fromMain ? " on main" : ""}:`,
      );
      for (const f of files) console.log(`  ${f}`);
      await exec(["git", "add", "-A"]);
      // The push trailer is normally stamped by the rebase's
      // `--exec`, once per replayed commit. `--from-main` in local mode is the
      // one flow with no rebase at all — there is no `origin/main` to catch up
      // with, local main IS the trunk — so the commit carries the trailer
      // itself. Without it the commit lands on main unattributed and the
      // pushes ledger has no row for a push that really happened.
      const trailer =
        opts.fromMain && publish.kind === "local"
          ? trailerArgs(landingTrailers)
          : [];
      await exec(["git", "commit", "-m", opts.message, ...trailer]);
    } else {
      console.log("No files to commit.");
    }
  } else if (status) {
    console.error(
      'Missing `-m "commit message"` flag. You have uncommitted changes.',
    );
    process.exit(1);
  }

  // 1b. Consume any merge marker this push did NOT produce — a manual
  //     `git rebase origin/main` whose post-rewrite hook did not run, or an
  //     earlier push that died between its rebase and its normalize. This
  //     used to be a blind `rm -rf` of the marker dir, which DESTROYED that
  //     signal: the tree still carried main's version of a generated file,
  //     nothing re-derived it, and the checks below failed on a *.generated.ts
  //     the agent never touched. Consuming (not discarding) is the fix; the
  //     regen is idempotent, so a genuinely stale marker costs one no-op pass.
  //     Runs AFTER the commit step above so the amend can never swallow
  //     uncommitted work.
  profiler.stepStart("normalize-inherited");
  await normalizeGeneratedArtifacts(root0, { pushId });
  profiler.stepEnd("normalize-inherited");

  // --from-main: rebase onto origin/main and push. No worktree merge.
  // Split fetch + rebase because `git pull --rebase --exec` isn't a valid
  // flag combination on Apple Git (the --exec doesn't propagate to rebase).
  if (opts.fromMain) {
    const mainRoot = await getWorktreeRoot();
    const pushLock = await pushLockFor(
      mainRoot,
      await assertLandsOnOwnRepository(mainRoot, mainRoot),
    );
    try {
      await withPushLock(
        pushLock,
        priority,
        profiler,
        async (grant) => {
          // Both steps are about the REMOTE's main. In local mode there is no
          // such thing: nothing else writes to this trunk, so there is nothing
          // to catch up with and nothing to replay onto. The commit above
          // carried its own trailer for exactly this case.
          //
          // The publisher's arm keeps a hazard it has always had, now stated
          // rather than implicit: this rebase moves the checkout's own `main`
          // BEFORE the push below, so a push that then fails leaves local main
          // advanced onto origin/main and already rebuilding. Accepted — the
          // commits are still there and a re-run pushes them — and it is
          // structurally absent from the local arm, which never pushes.
          if (publish.kind === "publish") {
            profiler.stepStart("fetch");
            console.log("Pulling main...");
            await exec(["git", "fetch", publish.remote, "main"]);
            profiler.stepEnd("fetch");

            profiler.stepStart("rebase");
            await exec(
              [
                "git",
                "rebase",
                `${publish.remote}/main`,
                "--exec",
                trailerAmendCommand(landingTrailers),
              ],
              undefined,
              rebaseEnv(),
            );
            profiler.stepEnd("rebase");
          }

          // The rest — normalize, checks, push — runs on the rebased code.
          await handOff(mainRoot, opSlug, pushId, "from-main", grant, profiler);
        },
        onLockRequested,
        onLockAcquired,
      );
    } catch (err) {
      profiler.complete("error");
      profiler.write();
      throw err;
    }
    profiler.complete("success");
    profiler.write();
    return;
  }

  // Steps 2–7 touch the shared main worktree and must be serialized
  // across all concurrent agents. The flock is held for the entire
  // critical section so no two pushes can race on main.
  const mainWorktree = await getMainWorktree(root0);
  const gitCommonDir = await assertLandsOnOwnRepository(root0, mainWorktree);
  const pushLock = await pushLockFor(mainWorktree, gitCommonDir);
  try {
    await withPushLock(
      pushLock,
      priority,
      profiler,
      async (grant) => {
        // 2. Pull main to ensure it's up to date before merging.
        // Use explicit fetch + merge instead of `git pull --ff-only` because FETCH_HEAD
        // is shared across all worktrees; a prior fetch in another worktree can leave
        // multiple "for-merge" entries, causing "Cannot fast-forward to multiple branches".
        //
        // Both steps are skipped when this checkout may not publish, and that
        // is the most important half of the gate. Left in, the fetch would pull
        // another repository's commits into the user's own `main` on every
        // push — and the first time their main diverged, the fast-forward would
        // fail and push would be broken for good. Local main is the trunk here,
        // and nothing but this push writes to it.
        if (publish.kind === "publish") {
          profiler.stepStart("fetch");
          console.log("Pulling main...");
          await exec(["git", "fetch", publish.remote, "main"], mainWorktree);
          profiler.stepEnd("fetch");
        }

        // 2a. Before main's checkout is touched or anything reaches the
        //     remote: refuse if a local change in main's checkout collides
        //     with what this push will merge there.
        await assertNoMainCollision(
          mainWorktree,
          publish.kind === "publish" ? `${publish.remote}/main` : "HEAD",
          branch,
        );

        if (publish.kind === "publish") {
          profiler.stepStart("ff-main");
          // Under main's tree write lock, like step 7: a child booting out of
          // main's checkout must not load half of this fast-forward.
          await withTreeWrite(mainWorktree, () =>
            exec(
              ["git", "merge", "--ff-only", `${publish.remote}/main`],
              mainWorktree,
            ),
          );
          profiler.stepEnd("ff-main");
        }

        // 3. Make the branch land on main as a fast-forward, and stamp what
        //    this push contributes with a shared push trailer so
        //    the server can group it as a single event. Which of three arms
        //    applies is a question about the branch's shape, not a preference.
        const shape = await readLandingShape();

        // Arm 1 — a branch that already CONTAINS main lands with no rebase at all.
        //     The rebase exists only to make step 6's ff-merge possible, and
        //     that is already true here — so rebasing would buy nothing and
        //     cost something real: it REWRITES every commit it replays, and on
        //     an update branch those include commits that belong to the
        //     upstream repository. Measured: after such a rebase, upstream's
        //     own sha was no longer an ancestor of main, so the next
        //     `./equin upstream merge` computed its merge base BELOW the
        //     commits already merged, re-presented them, and conflicted on a
        //     file nobody had touched twice. Landing by fast-forward keeps
        //     upstream's commits under the identities upstream gave them, and
        //     the next update merges only what is genuinely new.
        //
        //     The cost, stated rather than hidden: only the tip carries the
        //     trailer, so the ledger groups the tip alone. That is the right
        //     trade against rewriting another repository's commits.
        //
        //     The stamp is skipped entirely when there is nothing to land —
        //     amending a tip that IS main's tip would fork it away from main
        //     and break the very fast-forward this arm relies on.
        if (shape.containsMain) {
          if (shape.commits > 0) {
            await exec(
              [
                "git",
                "-c",
                "trailer.ifexists=replace",
                "commit",
                "--amend",
                "--no-edit",
                ...trailerArgs(landingTrailers),
              ],
              undefined,
              // Same suppression as push's rebases: `--amend` fires
              // `post-rewrite` too, and push owns the install→normalize
              // ordering itself.
              rebaseEnv(),
            );
          }
        } else if (shape.merges > 0) {
          // Arm 2 — merge commits on a branch main has moved past. The
          //     rebase below would flatten them, which is exactly what arm 1 exists
          //     to prevent — so refuse loudly instead of falling through to
          //     the one operation that destroys the topology.
          console.error(
            [
              `${branch} contains ${shape.merges} merge commit(s), and main has moved past it.`,
              ``,
              `Rebasing would flatten those merges — replaying everything they merged in as`,
              `your own commits, under new shas. For an upstream update that silently undoes`,
              `the merge: the next 'upstream merge' would re-present changes already merged.`,
              ``,
              `To resolve, in this worktree:`,
              `  1. git merge main        (the one sanctioned merge — do NOT rebase here)`,
              `  2. Resolve conflicts, then 'git add <files>' and 'git commit'`,
              `  3. Re-run ./equin push`,
            ].join("\n"),
          );
          profiler.complete("failed_rebase");
          profiler.write();
          process.exit(1);
        } else {
          // Arm 3 — the ordinary branch: rebase onto main so the merge is always a
          //     fast-forward. `--exec` runs after each replayed commit,
          //     amending it to carry the trailer.
          profiler.stepStart("rebase");
          const { exitCode: rebaseExit } = await runAllowFail(
            [
              "git",
              "rebase",
              "main",
              "--exec",
              trailerAmendCommand(landingTrailers),
            ],
            undefined,
            rebaseEnv(),
          );
          profiler.stepEnd("rebase");
          if (rebaseExit !== 0) {
            // Best-effort cleanup on the failure path; do not let an abort
            // failure mask the actionable rebase-conflict message printed below.
            await runAllowFail(["git", "rebase", "--abort"]);
            console.error(
              [
                `Rebase of ${branch} onto main failed (aborted).`,
                ``,
                `Conflicts during this rebase are routine when main has moved — resolve them yourself, don't bail out.`,
                ``,
                `To resolve:`,
                `  1. git fetch origin main`,
                `  2. git rebase origin/main     (NEVER 'git merge' — push re-rebases and a merge commit produces churn)`,
                `  3. Resolve conflicts, then 'git add <files>' and 'git rebase --continue'`,
                `     (or 'git rebase --abort' to bail out)`,
                `  4. Re-run ./equin push`,
                ``,
                `If main's shape has diverged so much your commit no longer applies, re-apply your`,
                `changes by hand onto a fresh worktree branched from origin/main. Never 'git reset'`,
                `your branch onto main — it stages a deletion of every commit that landed in between.`,
              ].join("\n"),
            );
            profiler.complete("failed_rebase");
            profiler.write();
            process.exit(1);
          }
        }

        // 4–7. Everything after the rebase — install, normalize, checks,
        //      push the branch, push main, fast-forward local main — runs on
        //      the REBASED code, as the land phase (`./land.ts`), inside this
        //      mutex and grant. See `./handoff.ts`.
        await handOff(root0, opSlug, pushId, "worktree", grant, profiler);
      },
      onLockRequested,
      onLockAcquired,
    );
  } catch (err) {
    profiler.complete("error");
    profiler.write();
    throw err;
  }

  profiler.complete("success");
  profiler.write();
};

// Named `pushAction` rather than `run`, which this file already uses for its
// exits-by-default git spawn helper. The mapper only reads the default export.
export default pushAction;

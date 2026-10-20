import { realpathSync } from "node:fs";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import {
  checkBroadcasts,
  installFatalSignalExit,
  opPriority,
  reportInterruptedPredecessor,
  runCheckSubprocess,
  signalOriginTap,
} from "@plugins/framework/plugins/cli/plugins/op-runtime/cli";
import { ensureDeps } from "@plugins/framework/plugins/cli/plugins/bootstrap/cli";
import {
  SKIP_POST_REWRITE_ENV,
  normalizeGeneratedArtifacts,
} from "@plugins/framework/plugins/cli/plugins/git-artifacts/cli";
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
import {
  spawnCaptured,
  spawnPassthrough,
} from "@plugins/infra/plugins/spawn/core";
import {
  describeAutoIdentity,
  describePublishTarget,
  ensureCommitIdentity,
  recordPushRejection,
  resolvePublishTarget,
} from "@plugins/infra/plugins/git/plugins/remotes/core";
import {
  actAsCheckoutNamespace,
  checkoutRef,
} from "@plugins/infra/plugins/paths/server";

// One bound for both capture helpers below, because every command they run is
// LOCAL git: `rev-parse`, `worktree list`, `status`, and the rebase. Nothing
// that talks to the network goes through them — `git fetch` / `git push` run
// through `exec` (spawnPassthrough) so the user sees the transfer progress —
// so no value here has to leave room for a slow remote.
//
// Five minutes is sized to the rebase, the longest of the four: it replays this
// branch's commits and amends a trailer onto each. The others are metadata
// reads that finish in milliseconds. Being one generous number rather than four
// tuned ones is deliberate — the helpers exist so call sites don't think about
// spawning, and every one of them is consumed by `process.exit(1)`, where a
// false positive costs the user a re-run of a push that was working.
const GIT_TIMEOUT_MS = 300_000;

// Exits-by-default spawn: a non-zero exit prints the command + captured
// stderr and exits(1) like `exec`, so a caller can never read a failed git
// call's empty stdout as real data (e.g. a failed `git status` absorbed as a
// "clean tree" and pushed over uncommitted changes). Returns trimmed stdout.
// For the sites that genuinely branch on the exit code, use `runAllowFail`.
async function run(cmd: string[], cwd?: string): Promise<string> {
  const result = await spawnCaptured(cmd, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    console.error(`Command failed (exit ${result.exitCode}): ${cmd.join(" ")}`);
    if (result.stderr.trim()) console.error(result.stderr.trim());
    process.exit(1);
  }
  return result.stdout.trim();
}

// Old behavior — returns both stdout and exitCode without throwing. Only for
// the sites that branch on the exit code themselves (a git command whose
// non-zero exit is an expected, handled outcome, e.g. a conflicting rebase).
// stderr now prints once after exit (it used to stream via "inherit").
async function runAllowFail(
  cmd: string[],
  cwd?: string,
  env?: Record<string, string | undefined>,
): Promise<{ stdout: string; exitCode: number }> {
  const result = await spawnCaptured(cmd, {
    cwd,
    env,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  return { stdout: result.stdout.trim(), exitCode: result.exitCode };
}

async function exec(
  cmd: string[],
  cwd?: string,
  env?: Record<string, string | undefined>,
): Promise<void> {
  const { exitCode } = await spawnPassthrough(cmd, { cwd, env });
  if (exitCode !== 0) {
    process.exit(1);
  }
}

// `exec` for the two commands that WRITE to the remote.
//
// A plain `exec` would exit(1) here, which is right — the push failed — but it
// would throw away the one thing the failure teaches: a checkout that used to
// be allowed to publish may not be any more (a revoked collaborator, a repo
// that changed hands, a fork the user re-pointed origin at). So the refusal is
// treated as evidence: re-probe the remote and RECORD what it says, which is
// newer than anything the cache holds. The next push then runs in local mode
// instead of failing the same way forever.
//
// Still passthrough, so the user reads git's own error before any of this.
async function execPublish(
  cmd: string[],
  cwd: string | undefined,
  root: string,
): Promise<void> {
  const { exitCode } = await spawnPassthrough(cmd, { cwd });
  if (exitCode === 0) return;
  console.error("");
  console.error(
    "The remote rejected that push — asking it whether this checkout may publish at all...",
  );
  const reprobed = await recordPushRejection(root);
  if (reprobed.kind === "local") {
    console.error(describePublishTarget(reprobed));
    console.error("Re-run ./singularity push to land the work on local main.");
  } else {
    // The probe and reality disagree: the remote accepts a write probe but
    // refused this push. That is a fact about THIS push — a protected branch,
    // a server hook, a branch someone else moved — not about access, so
    // nothing is recorded and git's own error above is the whole story.
    console.error(
      `${reprobed.remote} still accepts a write probe, so this was about the push itself ` +
        `(a protected branch, a server-side hook, or a branch that moved), not about access.`,
    );
  }
  process.exit(1);
}

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
// ordering itself — it installs the rebased lockfile FIRST, then normalizes, so
// the regen runs against node_modules that match the tree it is regenerating.
const rebaseEnv = (): Record<string, string | undefined> => ({
  ...process.env,
  [SKIP_POST_REWRITE_ENV]: "1",
});

// Install the lockfile the rebase just brought in — main may have added
// dependencies this worktree has never installed.
//
// Routed through `ensureDeps` rather than a bare `bun install --frozen-lockfile`,
// which is what this used to be. That call had three defects, all of which
// `ensureDeps` already answers and none of which are push-specific:
//
//   • UNSERIALIZED — it took no `.install.lock`, so it could run concurrently
//     with any other CLI-mediated install in this checkout, which is exactly the
//     `clonefileat` race bun 1.3.13 has no mutex for.
//   • UNSTAMPED — it left `node_modules/.singularity-deps` describing the
//     PRE-rebase inputs, so the very next CLI process saw stale inputs and
//     reinstalled everything. In this flow that next process is the checks
//     subprocess, four lines below: every push whose rebase touched the lockfile
//     paid for two full installs back-to-back, the second one while holding the
//     host-wide push mutex.
//   • UNATTRIBUTED — a failure exited 1 through the generic `exec` path with no
//     statement of which phase died.
//
// `--frozen-lockfile` is preserved via the option: the tree is mid-push, and a
// re-resolved `bun.lock` would dirty the very commit about to fast-forward onto
// main. The freshness gate is sound here for the same reason it is everywhere —
// `bun.lock` and every `package.json` are signature inputs, so a rebase that
// moved any of them installs, and one that moved none has nothing to install.
async function installRebasedDeps(root: string): Promise<void> {
  try {
    await ensureDeps({ root, frozenLockfile: true });
  } catch (err) {
    // The message is written to be the whole story (which phase, likely cause,
    // what to do); a stack would name this bootstrap rather than the problem.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Run the rebased-tree checks under the push's own grant — the one
// `withPushLock` holds for the whole critical section (see there), handed to the
// child via `grant.env()`. Taking the grant as a parameter rather than acquiring
// one here is what keeps "the checks run under an interactive grant" true by
// construction: there is no call that runs them without it.
//
// The spawn itself is `../check-subprocess.ts` — read its docblock for why a
// check pass is a separate process at all and why the selection is expressed as
// a flag rather than an id list. `--scope tree` narrows the pass to the push
// payload (see `Check.scope`): deploy-scoped checks verify the local gitignored
// dist that `build` produces, which never lands on main and which this push's
// own rebase moves the tree past by construction, so a push could only ever
// report the artifact as stale for having done its job. The eslint check always
// considers the full lintable set; its per-file closure cache decides what
// actually re-lints, so there is no lint scope env to thread through.
async function runRebasedChecks(
  root: string,
  grant: Grant,
  profiler: OpProfiler<"push">,
): Promise<boolean> {
  profiler.stepStart("checks");
  console.log("Running checks...");
  const result = await runCheckSubprocess({
    root,
    grant,
    select: { scope: "tree" },
    output: "inherit",
  });
  profiler.stepEnd("checks");
  return result.ok;
}

async function getWorktreeRoot(): Promise<string> {
  const stdout = await run(["git", "rev-parse", "--show-toplevel"]);
  if (!stdout) {
    console.error("Not in a git repository");
    process.exit(1);
  }
  return stdout;
}

async function getMainWorktree(): Promise<string> {
  const stdout = await run(["git", "worktree", "list", "--porcelain"]);
  // First worktree listed is always the main one
  const match = stdout.match(/^worktree (.+)$/m);
  if (!match) {
    console.error("Could not determine main worktree");
    process.exit(1);
  }
  return match[1]!;
}

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
 * the first entry of `git worktree list` for the checkout push was run from, but
 * an inherited `GIT_DIR` / `GIT_WORK_TREE` / `GIT_COMMON_DIR` — or any future
 * resolver that stops deriving it from `root` — would silently point it at a
 * different repository: a test's temp clone landing on the real `main`, or the
 * reverse. So the two are compared by git's own identity for a repository, the
 * common dir, and a push that would cross repositories stops before the lock.
 */
async function assertLandsOnOwnRepository(
  root: string,
  mainWorktree: string,
): Promise<string> {
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
  return ours;
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
  mainWorktree: string,
  gitCommonDir: string,
): Promise<PushLock> {
  if ((await checkoutRef(mainWorktree)).kind === "main") return pushPool;
  return repoPushLock(gitCommonDir);
}

// The push mutex is the `push` host-pool (host-admission): `pushPool.run(fn)`
// holds its single slot file — `~/.singularity/locks/push/slot-0.lock` — for the
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
// thing inside the mutex and `fn` receives it: the rebase, the install, the
// normalize, the checks and the merge all run under it, so they are admitted
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

const pushAction: CliAction<
  [],
  { message?: string; fromMain?: boolean }
> = async (opts) => {
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
  reportInterruptedPredecessor(opSlug);
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
      // The Singularity-Push trailer is normally stamped by the rebase's
      // `--exec`, once per replayed commit. `--from-main` in local mode is the
      // one flow with no rebase at all — there is no `origin/main` to catch up
      // with, local main IS the trunk — so the commit carries the trailer
      // itself. Without it the commit lands on main unattributed and the
      // pushes ledger has no row for a push that really happened.
      const trailer =
        opts.fromMain && publish.kind === "local"
          ? ["--trailer", `Singularity-Push=${pushId}`]
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
                `git -c trailer.ifexists=replace commit --amend --no-edit --trailer Singularity-Push=${pushId}`,
              ],
              undefined,
              rebaseEnv(),
            );
            profiler.stepEnd("rebase");
          }

          const fromMainRoot = await getWorktreeRoot();

          profiler.stepStart("bun-install");
          await installRebasedDeps(fromMainRoot);
          profiler.stepEnd("bun-install");

          // Forced for the same reason as the worktree path's 3c below:
          // this is a post-rebase repair whose result is what the checks
          // read, so it must not be skippable by a marker that never
          // arrived.
          profiler.stepStart("normalize");
          await normalizeGeneratedArtifacts(fromMainRoot, {
            pushId,
            force: true,
          });
          profiler.stepEnd("normalize");

          const ok = await runRebasedChecks(fromMainRoot, grant, profiler);
          if (!ok) {
            console.error(
              "Checks failed after rebase. Fix the issue and re-run ./singularity push " +
                "(your commit is still on HEAD; use `git reset --soft HEAD~1` to unstage it if needed).\n\n" +
                "If the failure is unrelated to your commits (e.g. a pre-existing issue on main), " +
                "try rebasing onto the latest main (`git fetch origin main && git rebase origin/main`) and re-running — the issue may already be fixed upstream.\n\n" +
                "If you cannot fix the failing check(s): STOP, report the failure to the user, and wait for instructions. " +
                "Do NOT work around check failures — not by disabling checks, editing check code, " +
                "expanding skip lists, committing via raw git, or any other means.",
            );
            profiler.complete("failed_checks");
            profiler.write();
            process.exit(1);
          }

          if (publish.kind === "publish") {
            profiler.stepStart("push-main");
            console.log("Pushing main...");
            await execPublish(["git", "push"], undefined, fromMainRoot);
            profiler.stepEnd("push-main");
          }
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
    console.log(
      publish.kind === "publish"
        ? "Done. Pushed directly from main."
        : "Done. Committed directly on local main. Nothing was pushed.",
    );
    return;
  }

  // Steps 2–7 touch the shared main worktree and must be serialized
  // across all concurrent agents. The flock is held for the entire
  // critical section so no two pushes can race on main.
  const mainWorktree = await getMainWorktree();
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
          await exec(
            ["git", "merge", "--ff-only", `${publish.remote}/main`],
            mainWorktree,
          );
          profiler.stepEnd("ff-main");
        }

        // 3. Make the branch land on main as a fast-forward, and stamp what
        //    this push contributes with a shared Singularity-Push trailer so
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
        //     `./singularity upstream merge` computed its merge base BELOW the
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
                "--trailer",
                `Singularity-Push=${pushId}`,
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
              `  3. Re-run ./singularity push`,
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
              `git -c trailer.ifexists=replace commit --amend --no-edit --trailer Singularity-Push=${pushId}`,
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
                `  4. Re-run ./singularity push`,
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

        // 3b. Ensure node_modules matches the rebased lockfile — main may
        //     have added dependencies the worktree hasn't installed yet.
        profiler.stepStart("bun-install");
        await installRebasedDeps(await getWorktreeRoot());
        profiler.stepEnd("bun-install");

        // 3c. Post-rebase normalize: regenerate auto-generated artifacts
        //     (docs, drizzle migrations) from the rebased source tree and
        //     amend the head commit. The merge drivers in .gitattributes
        //     accepted the upstream side during the rebase; this step makes
        //     the final commit canonical. Aborts on hand-edited migrations
        //     or on real conflict markers in CLAUDE.md prose.
        //
        //     `force` — regenerate whether or not a merge marker reached
        //     us. A missing marker is supposed to mean "the drivers never
        //     fired", but it is equally what a marker written where nobody
        //     reads it looks like, and the two cost wildly different
        //     amounts to confuse: the commit that lands on main is checked
        //     four lines below, and for a branch that edits a doc GENERATOR
        //     the upstream side the drivers took is wrong for the sources
        //     git just merged. Push already runs for minutes, so it buys
        //     the certainty; the `post-rewrite` hook, which fires after
        //     every rebase anyone does, stays marker-gated.
        profiler.stepStart("normalize");
        await normalizeGeneratedArtifacts(await getWorktreeRoot(), {
          pushId,
          force: true,
        });
        profiler.stepEnd("normalize");

        // 4. Run checks on the rebased tree — this is exactly what will land on
        //    main, and the pass is scoped to exactly that (`--scope tree`).
        //    Deploy-scoped checks verify the local gitignored dist/artifact
        //    store, which never lands on main and which the rebase above
        //    invalidates by construction; `build` and main's post-push
        //    auto-build assert those for real.
        //    Spawned as a subprocess so the check code comes from the rebased
        //    tree, not the (potentially stale) module cache of this process.
        const root = await getWorktreeRoot();
        const ok = await runRebasedChecks(root, grant, profiler);
        if (!ok) {
          console.error(
            `Checks failed after rebasing ${branch} onto main. ` +
              `Fix the issue and re-run ./singularity push ` +
              `(your commits are on ${branch}; use \`git reset --soft HEAD~1\` to unstage the last one if needed).\n\n` +
              `If the failure is unrelated to your commits (e.g. a pre-existing issue on main), ` +
              `try rebasing onto the latest main (\`git fetch origin main && git rebase origin/main\`) and re-running — the issue may already be fixed upstream.\n\n` +
              `If you cannot fix the failing check(s): STOP, report the failure to the user, and wait for instructions. ` +
              `Do NOT work around check failures — not by disabling checks, editing check code, ` +
              `expanding skip lists, committing via raw git, or any other means.`,
          );
          profiler.complete("failed_checks");
          profiler.write();
          process.exit(1);
        }

        // 5. Push the branch (force since rebase rewrites history — safe for
        //    single-owner worktree branches). Skipped in local mode: the branch
        //    has nowhere to go, and step 6 below is what the work is for.
        if (publish.kind === "publish") {
          profiler.stepStart("push-branch");
          console.log(`Pushing branch ${branch}...`);
          await execPublish(
            ["git", "push", "--force-with-lease", "-u", publish.remote, branch],
            undefined,
            root,
          );
          profiler.stepEnd("push-branch");
        }

        // 6. Fast-forward merge into main (guaranteed to succeed — we hold the
        //    lock, so no other push can have advanced main since our rebase).
        profiler.stepStart("ff-merge");
        console.log(`Merging ${branch} into main...`);
        await exec(["git", "merge", "--ff-only", branch], mainWorktree);
        profiler.stepEnd("ff-merge");

        // 7. Push main. The last step and the only one with nothing after it,
        //    so in local mode the push simply ends at 6 — main has advanced,
        //    and main's own auto-build takes it from there exactly as it does
        //    for a publisher.
        if (publish.kind === "publish") {
          profiler.stepStart("push-main");
          console.log("Pushing main...");
          await execPublish(["git", "push"], mainWorktree, root);
          profiler.stepEnd("push-main");
        }
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
  console.log(
    publish.kind === "publish"
      ? `Done. ${branch} merged into main and pushed.`
      : `Done. ${branch} merged into local main. Nothing was pushed.`,
  );
};

// Named `pushAction` rather than `run`, which this file already uses for its
// exits-by-default git spawn helper. The mapper only reads the default export.
export default pushAction;

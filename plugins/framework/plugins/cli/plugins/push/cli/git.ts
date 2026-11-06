import {
  asAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { listWorktreeEntries } from "@plugins/infra/plugins/worktree/server";
import {
  spawnCaptured,
  spawnPassthrough,
} from "@plugins/infra/plugins/spawn/core";
import {
  describePublishTarget,
  recordPushRejection,
} from "@plugins/infra/plugins/git/plugins/remotes/core";

// The git helpers both halves of a push use: the driver (`./run.ts`, up to the
// rebase) and the land phase (`./land.ts`, after it).

// One bound for both capture helpers below, because every command they run is
// LOCAL git: `rev-parse`, `status`, and the rebase. Nothing
// that talks to the network goes through them — `git fetch` / `git push` run
// through `exec` (spawnPassthrough) so the user sees the transfer progress —
// so no value here has to leave room for a slow remote.
//
// Five minutes is sized to the rebase, the longest of the three: it replays this
// branch's commits and amends a trailer onto each. The others are metadata
// reads that finish in milliseconds. Being one generous number rather than three
// tuned ones is deliberate — the helpers exist so call sites don't think about
// spawning, and every one of them is consumed by `process.exit(1)`, where a
// false positive costs the user a re-run of a push that was working.
export const GIT_TIMEOUT_MS = 300_000;

// Exits-by-default spawn: a non-zero exit prints the command + captured
// stderr and exits(1) like `exec`, so a caller can never read a failed git
// call's empty stdout as real data (e.g. a failed `git status` absorbed as a
// "clean tree" and pushed over uncommitted changes). Returns trimmed stdout.
// For the sites that genuinely branch on the exit code, use `runAllowFail`.
export async function run(cmd: string[], cwd?: string): Promise<string> {
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
export async function runAllowFail(
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

export async function exec(
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
export async function execPublish(
  cmd: string[],
  cwd: string | undefined,
  root: string,
): Promise<void> {
  const { exitCode } = await spawnPassthrough(cmd, { cwd });
  if (exitCode === 0) return;
  await explainPushRejection(root);
}

async function explainPushRejection(root: string): Promise<never> {
  console.error("");
  console.error(
    "The remote rejected that push — asking it whether this checkout may publish at all...",
  );
  const reprobed = await recordPushRejection(root);
  if (reprobed.kind === "local") {
    console.error(describePublishTarget(reprobed));
    console.error("Re-run ./equin push to land the work on local main.");
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

// Publishes `branch` as the remote's main, BEFORE local main moves.
//
// The push mutex serializes the pushes on this machine, not every writer of
// the remote: a commit made on GitHub's web editor (or from another clone) can
// land on the remote main between this push's fetch and its final write. When
// local main was fast-forwarded first and the remote write then refused, local
// main was left holding a commit the remote never got — diverged from it, so
// every worktree branched from it inherited the commit as its own and the next
// push failed at its `--ff-only` pull. Writing the remote first makes the
// remote's own non-fast-forward refusal the atomic gate: lose the race and
// local main is untouched, so a re-run fetches the new commit and rebases
// onto it like any other.
export async function publishMain(
  remote: string,
  branch: string,
  root: string,
): Promise<void> {
  const { exitCode } = await spawnPassthrough([
    "git",
    "push",
    remote,
    `${branch}:refs/heads/main`,
  ]);
  if (exitCode === 0) return;

  // A refusal is either the race above or a question of access. Fetch and
  // ask which: a remote main that is no longer below the branch moved.
  await exec(["git", "fetch", remote, "main"]);
  const cmd = ["git", "merge-base", "--is-ancestor", `${remote}/main`, branch];
  const ancestry = await spawnCaptured(cmd, { timeoutMs: GIT_TIMEOUT_MS });
  if (ancestry.exitCode === 1) {
    console.error(
      [
        ``,
        `${remote}/main moved while this push ran — someone else landed a commit on it.`,
        `Local main was NOT touched, and nothing of this push reached ${remote}/main.`,
        `Re-run ./equin push: it fetches the new commit and rebases onto it.`,
      ].join("\n"),
    );
    process.exit(1);
  }
  if (ancestry.exitCode !== 0) {
    console.error(
      `Command failed (exit ${ancestry.exitCode}): ${cmd.join(" ")}`,
    );
    if (ancestry.stderr.trim()) console.error(ancestry.stderr.trim());
    process.exit(1);
  }
  await explainPushRejection(root);
}

export async function getWorktreeRoot(): Promise<AppPath> {
  const stdout = await run(["git", "rev-parse", "--show-toplevel"]);
  if (!stdout) {
    console.error("Not in a git repository");
    process.exit(1);
  }
  return asAppPath(stdout);
}

// Read from the worktree plugin's admin-file listing, never `git worktree list`:
// that dies ("failed to read .git/worktrees/<other>/commondir") beside any
// concurrent `git worktree add` half-way through writing its entry.
export async function getMainWorktree(root: AppPath): Promise<AppPath> {
  // The main worktree is always listed first.
  const [main] = await listWorktreeEntries(root);
  if (!main) {
    console.error("Could not determine main worktree");
    process.exit(1);
  }
  return asAppPath(main.path);
}

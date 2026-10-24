import type { CliAction } from "@plugins/framework/plugins/cli/core";
import {
  getMainRepoRoot,
  getWorktreeRoot,
  spawnCaptured,
  spawnExpectOk,
  spawnPassthrough,
} from "@plugins/infra/plugins/spawn/core";
import {
  describeAutoIdentity,
  ensureCommitIdentity,
  resolvePublishTarget,
} from "@plugins/infra/plugins/git/plugins/remotes/core";
import { fetchUpstreamStatus } from "@plugins/upstream/core";
import { noUpstreamSentence } from "./internal/describe";

/** Local git metadata reads: `rev-parse`, `status`, `diff --name-only`. */
const GIT_TIMEOUT_MS = 60_000;

/**
 * Where generated migration SQL lives. Spelled here the way every other CLI
 * command spells it (`regen-migrations`, the migration checks) — a conflict
 * under this prefix is the one thing this command tells you to stop on.
 */
const MIGRATIONS_SUBDIR = "plugins/database/plugins/migrations/data";

function refuse(message: string): never {
  console.error(message);
  process.exit(1);
}

function lines(result: { stdout: string }): string[] {
  return result.stdout.split("\n").filter((l) => l.trim().length > 0);
}

/** Paths git still considers unresolved (unmerged index entries). */
async function unmergedPaths(root: string): Promise<string[]> {
  return lines(
    await spawnExpectOk(["git", "diff", "--name-only", "--diff-filter=U"], {
      cwd: root,
      timeoutMs: GIT_TIMEOUT_MS,
    }),
  );
}

const run: CliAction<[], { continue?: boolean }> = async (opts) => {
  const root = await getWorktreeRoot();

  // Same refusal as `toolchain upgrade`, for the same reason: main's backend is
  // serving from this checkout and rebuilds itself the moment `refs/heads/main`
  // moves. An update is proven in a worktree and reaches main through
  // `./equin push`, which the user runs. It covers both verbs — there is
  // no upstream merge to conclude on main either.
  if (root === (await getMainRepoRoot()))
    refuse(
      "Refusing to merge upstream into the main checkout. Main rebuilds itself the moment its ref moves, " +
        "so an update is merged in a worktree, built and looked at there, and lands on main through `./equin push`.",
    );

  // Both verbs may write a merge commit, so its signer is settled first —
  // the same rule `push` applies (see ensureCommitIdentity).
  const identity = await ensureCommitIdentity(
    root,
    await resolvePublishTarget(root),
  );
  if (identity.kind === "refuse") refuse(identity.message);
  if (identity.kind === "auto" && identity.written)
    console.log(describeAutoIdentity(identity));

  if (opts.continue === true) return await continueMerge(root);
  return await startMerge(root);
};

/**
 * Conclude the merge this command started.
 *
 * It exists so that resolving a conflict never requires a raw `git commit`.
 * The repo's rule is that an agent never commits — `./equin push -m` is
 * the only way work is committed — and a merge left half-done is the one place
 * that rule had no answer, because `push` would also PUSH, which is exactly
 * what an upstream update must not do until the user says so. So the command
 * that opened the merge closes it.
 */
async function continueMerge(root: string): Promise<void> {
  // Is a merge actually in progress? `--verify --quiet` exits non-zero when
  // MERGE_HEAD does not exist, which is a reading rather than a failure — so
  // this is the one git call here that may come back non-zero.
  const mergeHead = await spawnCaptured(
    ["git", "rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
    { cwd: root, timeoutMs: GIT_TIMEOUT_MS },
  );
  if (mergeHead.exitCode !== 0)
    refuse(
      "No merge is in progress here, so there is nothing to conclude. " +
        "`--continue` finishes a `./equin upstream merge` that stopped on conflicts; " +
        "a merge that did not conflict was already concluded by git itself.",
    );

  // Unresolved paths FIRST, before anything is staged. Staging a conflicted
  // path is how git records "resolved", so doing it for the user would silently
  // pick a side — on a delete/modify conflict, whichever side the working tree
  // happens to hold.
  const unmerged = await unmergedPaths(root);
  if (unmerged.length > 0) {
    const migrations = unmerged.filter((p) => p.startsWith(MIGRATIONS_SUBDIR));
    refuse(
      [
        `${unmerged.length} path${unmerged.length === 1 ? " is" : "s are"} still unresolved, so the merge cannot be concluded:`,
        ``,
        ...unmerged.map((p) => `  ${p}`),
        ``,
        ...(migrations.length > 0
          ? [
              `One of them is a MIGRATION. Stop and report it rather than resolving it: two sides`,
              `altering the same table is a decision a person makes.`,
              ``,
            ]
          : []),
        `Resolve each one, \`git add\` it, then re-run \`./equin upstream merge --continue\`.`,
        `To back out of the merge entirely: \`git merge --abort\`.`,
      ].join("\n"),
    );
  }

  // Nothing is unresolved, so this stages only edits made AFTER a resolution was
  // added — it can no longer decide a conflict. `-u` and not `-A`: a scratch
  // file an agent left lying about is not part of the merge.
  await spawnExpectOk(["git", "add", "-u"], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
  });

  // A resolution can be staged and still contain `<<<<<<<`. git says so through
  // `--check`, which also reports whitespace — so the exit code is ignored and
  // only the conflict-marker lines are read.
  const checked = await spawnCaptured(["git", "diff", "--cached", "--check"], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  const marked = [
    ...new Set(
      lines(checked)
        .filter((l) => l.includes("leftover conflict marker"))
        .map((l) => l.slice(0, l.indexOf(":"))),
    ),
  ];
  if (marked.length > 0)
    refuse(
      [
        `These files are staged with conflict markers still in them:`,
        ``,
        ...marked.map((p) => `  ${p}`),
        ``,
        `Finish resolving them, \`git add\` each one, and re-run \`./equin upstream merge --continue\`.`,
      ].join("\n"),
    );

  const { exitCode } = await spawnPassthrough(["git", "commit", "--no-edit"], {
    cwd: root,
  });
  if (exitCode !== 0)
    refuse(`\ngit could not conclude the merge (exit ${exitCode}).`);

  console.log(
    [
      ``,
      `Merge concluded.`,
      ``,
      `Next: \`./equin build\` (in the background), confirm the deploy receipt says ok,`,
      `open the worktree's URL and check the app still works. Then report — the user lands it.`,
    ].join("\n"),
  );
}

async function startMerge(root: string): Promise<void> {
  const branch = (
    await spawnExpectOk(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: root,
      timeoutMs: GIT_TIMEOUT_MS,
    })
  ).stdout.trim();
  if (branch === "HEAD")
    refuse(
      "Refusing to merge onto a detached HEAD — the merge commit would belong to no branch. Check out this worktree's branch first.",
    );

  // A merge onto a dirty tree mixes uncommitted work into the conflict
  // resolution, and there is then no way to tell which side a hunk came from.
  const dirty = (
    await spawnExpectOk(["git", "status", "--porcelain"], {
      cwd: root,
      timeoutMs: GIT_TIMEOUT_MS,
    })
  ).stdout.trim();
  if (dirty !== "")
    refuse(
      `Refusing to merge with uncommitted changes in the tree — a conflict resolution could not then be told apart from your own edits.\n\n${dirty}\n\nLand or set those changes aside first, then re-run.`,
    );

  const status = await fetchUpstreamStatus(root);
  if (status.kind === "no-upstream")
    refuse(`${noUpstreamSentence(status.reason)} There is nothing to merge.`);
  if (status.kind === "unreachable")
    refuse(
      `Could not reach ${status.remote} (${status.url}).\n  ${status.detail}\n\n` +
        `Nothing was fetched, so there is nothing to merge yet and your tree is untouched. Try again when you can reach it.`,
    );
  if (status.kind === "current") {
    console.log(`Already up to date with ${status.ref}. Nothing to merge.`);
    return;
  }

  const plural = status.count === 1 ? "" : "s";
  console.log(
    `Merging ${status.count} commit${plural} from ${status.ref} into ${branch}…\n`,
  );
  // git concludes this itself when it can: a fast-forward moves the branch and a
  // real merge writes its own commit. `--continue` below is only ever for the
  // path where git stopped.
  const { exitCode } = await spawnPassthrough(["git", "merge", status.ref], {
    cwd: root,
  });

  if (exitCode === 0) {
    console.log(
      [
        ``,
        `Merged ${status.ref} into ${branch}.`,
        ``,
        `Next: \`./equin build\` (in the background), confirm the deploy receipt says ok,`,
        `open the worktree's URL and check the app still works. Then report — the user lands it.`,
      ].join("\n"),
    );
    return;
  }

  // Conflicts stay in the tree. `git merge` already printed which files it
  // could not resolve; what it cannot say is which of them matter.
  const unmerged = await unmergedPaths(root);
  const migrations = unmerged.filter((p) => p.startsWith(MIGRATIONS_SUBDIR));

  console.error(
    [
      ``,
      `The merge stopped on conflicts; they are left in the tree for you to resolve.`,
      ``,
      `Generated files re-derive themselves — the .gitattributes merge drivers take the upstream`,
      `side and the generators re-run over the merged tree — so do not hand-resolve one.`,
      ...(migrations.length > 0
        ? [
            ``,
            `A MIGRATION IS CONFLICTED. Stop and report it rather than resolving it: two sides altering`,
            `the same table is a decision a person makes.`,
            ...migrations.map((p) => `  ${p}`),
          ]
        : []),
      ``,
      `When each one is resolved and \`git add\`ed, run \`./equin upstream merge --continue\` to`,
      `conclude the merge. To back out entirely: \`git merge --abort\`.`,
    ].join("\n"),
  );
  process.exit(1);
}

export default run;

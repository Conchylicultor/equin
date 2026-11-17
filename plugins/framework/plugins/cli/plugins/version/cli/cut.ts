import type { CliAction } from "@plugins/framework/plugins/cli/core";
import {
  getMainRepoRoot,
  getWorktreeRoot,
  spawnCaptured,
  spawnExpectOk,
  spawnPassthrough,
} from "@plugins/infra/plugins/spawn/core";
import { resolvePublishTarget } from "@plugins/infra/plugins/git/plugins/remotes/core";
import { actAsCheckoutNamespace } from "@plugins/infra/plugins/paths/core";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import {
  convergenceOf,
  sameCommit,
} from "@plugins/build/plugins/deployment/core";
import { readServedDeployment } from "@plugins/build/plugins/deployment/cli";
import { createBuildRunRecorder } from "@plugins/build/plugins/run-ledger/cli";
import { UPSTREAM_BRANCH } from "@plugins/upstream/core";
import {
  nextReleaseTag,
  RELEASE_TAG_GLOB,
  releaseTagMessage,
  releaseTags,
  releaseVersion,
} from "@plugins/upstream/plugins/release/core";

/** Local ref reads. */
const GIT_TIMEOUT_MS = 60_000;
/** The one network read: the publish remote's main and release tags. */
const FETCH_TIMEOUT_MS = 300_000;

function refuse(message: string): never {
  console.error(message);
  process.exit(1);
}

function lines(stdout: string): string[] {
  return stdout.split("\n").filter((l) => l.trim().length > 0);
}

async function git(root: string, ...args: string[]): Promise<string> {
  return (
    await spawnExpectOk(["git", ...args], {
      cwd: root,
      timeoutMs: GIT_TIMEOUT_MS,
    })
  ).stdout.trim();
}

/**
 * `./equin version cut` — make main's HEAD a release.
 *
 * A release is what every clone is told about and updates to, so it must be a
 * main that is known good. Each refusal below is one way it might not be:
 *
 * 1. **This checkout publishes** (`resolvePublishTarget`). A clone has nowhere
 *    to push a tag its users would see.
 * 2. **Main's checkout, on `main`.** The deploy read below is this checkout's
 *    own served dist, and main's is the one the author runs.
 * 3. **HEAD is published** — in `<remote>/main` after a fetch. A tag on a
 *    commit upstream's main does not hold is not a release a clone would ever
 *    see (detection reads tags merged into upstream's main).
 * 4. **Main serves HEAD** — `readServedDeployment()` converged on HEAD: the
 *    deploy of this exact commit came up.
 * 5. **Main's last build of HEAD passed** — the newest closed `build_runs` row
 *    of a plain main build names HEAD and exited 0, checks included.
 * 6. **HEAD is not already a release.**
 *
 * Not a flag on `push`: a release must follow a CONFIRMED green main, which
 * `push` cannot know when it lands — main builds itself after the push.
 */
const run: CliAction<[], { message?: string; dryRun?: boolean }> = async (
  opts,
) => {
  const root = await getWorktreeRoot();
  if (root !== (await getMainRepoRoot()))
    refuse(
      `Run \`./equin version cut\` in main's checkout (${await getMainRepoRoot()}): a release is main's HEAD, ` +
        `checked against what main serves and main's own build of it.`,
    );

  const target = await resolvePublishTarget(root);
  if (target.kind !== "publish")
    refuse(
      `This checkout cannot publish (${target.reason.kind}), so it cannot cut a release: a release is a tag ` +
        `pushed where clones fetch from. Releases are cut by the checkout that owns the repository.`,
    );

  const branch = await git(root, "rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== UPSTREAM_BRANCH)
    refuse(
      `Main's checkout is on \`${branch}\`, not \`${UPSTREAM_BRANCH}\`. A release is cut from main.`,
    );
  const head = await git(root, "rev-parse", "HEAD");

  // Fetch first: "is HEAD published" and "which release names are taken" are
  // questions about the remote, not about refs as old as the last fetch.
  const fetchArgv = [
    "git",
    "fetch",
    target.remote,
    UPSTREAM_BRANCH,
    `refs/tags/${RELEASE_TAG_GLOB}:refs/tags/${RELEASE_TAG_GLOB}`,
  ];
  const fetched = await spawnCaptured(fetchArgv, {
    cwd: root,
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (fetched.exitCode !== 0 || fetched.timedOut)
    refuse(
      `Could not fetch ${target.remote} (${target.url}), so whether HEAD is published and which release names ` +
        `are taken are unknown. Nothing was tagged.\n\n${fetched.stderr.trim()}`,
    );

  const remoteMain = `${target.remote}/${UPSTREAM_BRANCH}`;
  const published = await spawnCaptured(
    ["git", "merge-base", "--is-ancestor", head, remoteMain],
    { cwd: root, timeoutMs: GIT_TIMEOUT_MS },
  );
  if (published.exitCode === 1)
    refuse(
      `HEAD (${head.slice(0, 9)}) is not on ${remoteMain}. Push main first: a tag on a commit ${target.remote}'s ` +
        `main does not hold is a release no clone would see.`,
    );
  if (published.exitCode !== 0)
    refuse(
      `git merge-base --is-ancestor ${head} ${remoteMain} failed:\n${published.stderr.trim()}`,
    );

  const already = releaseTags(
    lines(await git(root, "tag", "--points-at", head, "-l", RELEASE_TAG_GLOB)),
  );
  if (already.length > 0)
    refuse(
      `HEAD is already released as ${already.map((r) => r.tag).join(", ")}. Nothing to cut.`,
    );

  const namespace = await actAsCheckoutNamespace(root);
  const deployment = await readServedDeployment();
  const convergence = convergenceOf(deployment);
  if (
    convergence !== "converged" ||
    !deployment.target.resolved ||
    !sameCommit(deployment.target.value, head)
  )
    refuse(
      `Main is not serving HEAD (${head.slice(0, 9)}): its deployment reads ${convergence}. ` +
        `A release is a main whose deploy came up — wait for main's build of HEAD to finish, or fix it.`,
    );

  const recorder = createBuildRunRecorder(namespace);
  const last = await recorder
    .lastClosedRun({ only: MAIN_COMPOSITION_ID })
    .finally(() => recorder.close());
  if (last.kind !== "run")
    refuse(
      `Main has no finished build on record (${last.kind}), so nothing says HEAD built and passed its checks.`,
    );
  if (last.commitHash === null || !sameCommit(last.commitHash, head))
    refuse(
      `Main's last finished build was of ${last.commitHash?.slice(0, 9) ?? "an unknown commit"}, not HEAD ` +
        `(${head.slice(0, 9)}). Wait for main's build of HEAD to finish.`,
    );
  if (last.exitCode !== 0)
    refuse(
      `Main's last build of HEAD failed (exit ${last.exitCode ?? "unknown"}). A release must be a main that ` +
        `built and passed its checks.`,
    );

  const tag = nextReleaseTag(
    new Date(),
    lines(await git(root, "tag", "-l", RELEASE_TAG_GLOB)),
  );
  const message = opts.message ?? releaseTagMessage(tag);
  if (message.includes("\n") || message.trim() === "")
    refuse("A release tag's message is one non-empty line.");

  if (opts.dryRun === true) {
    console.log(
      `Every check passed. Would tag ${head.slice(0, 9)} as ${tag} ("${message}") and push it to ${target.remote}.`,
    );
    return;
  }

  await git(root, "tag", "-a", tag, "-m", message, head);
  const pushed = await spawnPassthrough(
    ["git", "push", target.remote, `refs/tags/${tag}`],
    { cwd: root },
  );
  if (pushed.exitCode !== 0) {
    // Drop the local tag so a retry names the release afresh instead of
    // finding a tag nobody else can see.
    await git(root, "tag", "-d", tag);
    refuse(
      `\nCould not push ${tag} to ${target.remote} (exit ${pushed.exitCode}); the local tag was removed. Nothing was released.`,
    );
  }
  console.log(
    `\nReleased ${releaseVersion(tag)}: ${tag} on ${head.slice(0, 9)}, pushed to ${target.remote} (${target.url}).`,
  );
};

export default run;

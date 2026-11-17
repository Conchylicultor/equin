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
import { unresolved } from "@plugins/network/plugins/live/plugins/live-state/core";
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

/** Is `commit` on the line leading to `ref` (or `ref` itself)? */
async function isAncestor(
  root: string,
  commit: string,
  ref: string,
): Promise<boolean> {
  const r = await spawnCaptured(
    ["git", "merge-base", "--is-ancestor", commit, ref],
    { cwd: root, timeoutMs: GIT_TIMEOUT_MS },
  );
  if (r.exitCode === 0) return true;
  if (r.exitCode === 1) return false;
  refuse(
    `git merge-base --is-ancestor ${commit} ${ref} failed:\n${r.stderr.trim()}`,
  );
}

/** " (HEAD is <sha>)" when main has moved past the served commit. */
function behind(served: string, head: string): string {
  return served === head
    ? ""
    : ` (main's HEAD has since moved to ${head.slice(0, 9)})`;
}

/**
 * `./equin version cut` — make the commit main SERVES a release.
 *
 * Not HEAD: main moves many times a day, so "main serves HEAD" is true only in
 * the windows between a build finishing and the next push, and a cut that
 * needed it was a race. The served commit is the newest main known good — its
 * deploy came up (a deploy whose backend does not rolls its dist back) and its
 * build passed — so it is the one to release, whatever landed since.
 *
 * Each refusal below is one way it might not be a good release:
 *
 * 1. **Main's checkout, on `main`.** The served dist read is main's.
 * 2. **This checkout publishes** (`resolvePublishTarget`). A clone has nowhere
 *    to push a tag its users would see.
 * 3. **Main serves a known commit** — the served dist's `.build-commit`
 *    (`readServedDeployment(namespace)`), and it is on main's line (an
 *    ancestor of HEAD, or HEAD).
 * 4. **It is published** — in `<remote>/main` after a fetch. A tag on a commit
 *    upstream's main does not hold is not a release a clone would ever see
 *    (detection reads tags merged into upstream's main).
 * 5. **No release holds it yet** — neither on it nor on a later commit: a
 *    release older than the newest one would read as a step back.
 * 6. **Its build passed** — the newest closed plain main build of that commit
 *    (`build_runs`) exited 0, checks included.
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
      `Run \`./equin version cut\` in main's checkout (${await getMainRepoRoot()}): a release is the commit ` +
        `main serves, checked against main's own build of it.`,
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

  const namespace = await actAsCheckoutNamespace(root);
  const web = (await readServedDeployment(namespace)).deployable.find(
    (c) => c.id === "web",
  );
  const servedCommit = web?.commit ?? unresolved("no web carrier");
  if (!servedCommit.resolved)
    refuse(
      `Main serves no known commit (${servedCommit.reason}), so there is nothing deployed to release. ` +
        `Wait for main's build to finish, or fix it.`,
    );
  const served = servedCommit.value;
  const short = served.slice(0, 9);
  if (!(await isAncestor(root, served, head)))
    refuse(
      `Main serves ${short}, which is not on main's line (HEAD ${head.slice(0, 9)}). A release is a commit of main.`,
    );

  // Fetch first: "is it published" and "which release names are taken" are
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
      `Could not fetch ${target.remote} (${target.url}), so whether ${short} is published and which release ` +
        `names are taken are unknown. Nothing was tagged.\n\n${fetched.stderr.trim()}`,
    );

  const remoteMain = `${target.remote}/${UPSTREAM_BRANCH}`;
  if (!(await isAncestor(root, served, remoteMain)))
    refuse(
      `The served commit (${short}) is not on ${remoteMain}. Push main first: a tag on a commit ` +
        `${target.remote}'s main does not hold is a release no clone would see.`,
    );

  const onIt = releaseTags(
    lines(
      await git(root, "tag", "--points-at", served, "-l", RELEASE_TAG_GLOB),
    ),
  );
  if (onIt.length > 0)
    refuse(
      `The served commit (${short}) is already released as ${onIt.map((r) => r.tag).join(", ")}. Nothing to cut.`,
    );
  const later = releaseTags(
    lines(await git(root, "tag", "--contains", served, "-l", RELEASE_TAG_GLOB)),
  );
  if (later.length > 0)
    refuse(
      `A later commit is already released (${later.map((r) => r.tag).join(", ")}), so releasing the served ` +
        `commit (${short}) would be a step back. Wait for main to serve a newer build.`,
    );

  const recorder = createBuildRunRecorder(namespace);
  const build = await recorder
    .lastClosedRunOf({ only: MAIN_COMPOSITION_ID }, served)
    .finally(() => recorder.close());
  if (build.kind !== "run")
    refuse(
      `Main has no finished build of ${short} on record (${build.kind}), so nothing says it built and passed ` +
        `its checks.`,
    );
  if (build.exitCode !== 0)
    refuse(
      `Main's last build of ${short} failed (exit ${build.exitCode ?? "unknown"}). A release must be a main that ` +
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
      `Every check passed. Would tag the served commit ${short}${behind(served, head)} as ${tag} ("${message}") and push it to ${target.remote}.`,
    );
    return;
  }

  await git(root, "tag", "-a", tag, "-m", message, served);
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
    `\nReleased ${releaseVersion(tag)}: ${tag} on ${short}${behind(served, head)}, pushed to ${target.remote} (${target.url}).`,
  );
};

export default run;

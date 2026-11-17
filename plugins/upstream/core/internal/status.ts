import {
  classifyRemoteFailure,
  resolveUpstreamRemote,
  type RemoteFailure,
} from "@plugins/infra/plugins/git/plugins/remotes/core";
import {
  SpawnFailedError,
  spawnCaptured,
  spawnExpectOk,
} from "@plugins/infra/plugins/spawn/core";
import {
  newestReleaseTag,
  RELEASE_TAG_GLOB,
} from "@plugins/upstream/plugins/release/core";

/**
 * The trunk, on both sides: the local `main` every worktree branches off and a
 * release is measured against, and the upstream `main` releases are cut on.
 */
export const UPSTREAM_BRANCH = "main";

/** One fetch of a branch that may be far ahead, plus its release tags, over the network. */
const FETCH_TIMEOUT_MS = 300_000;

/** `for-each-ref` / `merge-base` over refs already on disk. */
const LOCAL_TIMEOUT_MS = 60_000;

/**
 * Where this checkout stands against upstream's newest RELEASE, as a state with
 * a reason rather than a value that could be read as "nothing new" for either
 * "up to date" or "we never got to ask".
 *
 * A clone is measured against releases — annotated `v<YYYY.MM.DD>` tags the
 * author cuts on purpose (`./equin version cut`) — never against upstream's
 * `main`, which moves a hundred times a day and would leave every clone
 * permanently "behind".
 *
 * - `no-upstream` — this checkout publishes to its own remote (the author), or
 *   has no remote at all. There is nothing to be behind.
 * - `unreachable` — upstream exists and we could not ask it. Distinct from both
 *   of its neighbours on purpose: folding it into `current` would report "no
 *   updates" on the strength of a question nobody answered, and folding it into
 *   `no-upstream` would deny the remote exists.
 * - `no-release` — upstream answered and has cut no release yet: nothing to
 *   tell the user about.
 * - `current` — upstream's newest release is in local `main`.
 * - `behind` — it is not. `current` names the newest release local `main` does
 *   hold (`null`: none, e.g. a clone made before the first release).
 */
export type UpstreamStatus =
  | { kind: "no-upstream"; reason: "is-publisher" | "no-remote" }
  | { kind: "unreachable"; remote: string; url: string; detail: string }
  | {
      kind: "no-release";
      remote: string;
      url: string;
      current: string | null;
    }
  | {
      kind: "current";
      remote: string;
      url: string;
      release: string;
      /** Where the fetched release lives locally (see {@link upstreamReleaseNamespace}). */
      ref: string;
    }
  | {
      kind: "behind";
      remote: string;
      url: string;
      /** The newest release local `main` holds, if any. */
      current: string | null;
      /** Upstream's newest release — the tag an update merges. */
      latest: string;
      /** Where that release lives locally (see {@link upstreamReleaseNamespace}). */
      ref: string;
    };

/**
 * Which failures mean "we could not ask", and are therefore a state to render
 * rather than a bug to throw on.
 *
 * `unreachable` is the offline laptop. `no-credentials` joins it because it is
 * the same fact from the other end: the remote never learned who we are, so it
 * said nothing about whether updates exist. Neither is an incident and neither
 * gets louder by being thrown.
 *
 * `denied` and `unclassified` are NOT here. A remote that recognised us and
 * refused the read (a repo deleted, made private, or a typo'd URL) is a real
 * answer about a broken configuration that will not fix itself, and a failure
 * nothing classified is a bug. Both must stay loud.
 */
export function isCouldNotAsk(kind: RemoteFailure["kind"]): boolean {
  return kind === "unreachable" || kind === "no-credentials";
}

/** Where this checkout's OWN tags live — the releases it cuts, if it publishes. */
export const OWN_RELEASE_NAMESPACE = "refs/tags/";

/**
 * Where upstream's release tags are fetched to: a namespace of their own,
 * `refs/release-tags/<remote>/`, never `refs/tags/`.
 *
 * Mirrored, not merged into the user's tags: the fetch force-updates and
 * prunes it, so a release upstream re-cut or retracted reads as upstream says,
 * and a tag of the user's own (a fork that cuts releases too, a `v2026.11.17`
 * of their own) can neither collide with one of upstream's — `refs/tags/`
 * would refuse the fetch outright, "would clobber existing tag", every day
 * after — nor be mistaken for one.
 */
export function upstreamReleaseNamespace(remote: string): string {
  return `refs/release-tags/${remote}/`;
}

/**
 * The newest release tag in `namespace` reachable from `ref` — the version
 * `ref` is "on" — or `null` when it holds none.
 *
 * Read as the release tags merged into `ref`, ordered by the release grammar,
 * not `git describe`: describe answers the topologically NEAREST matching tag,
 * which after a merge can be an older release than one the history also holds,
 * and its glob would also match a tag like `v1` that is no release.
 */
export async function currentRelease(
  root: string,
  ref: string,
  namespace: string,
): Promise<string | null> {
  const newest = newestReleaseTag(
    await releaseTagsMergedInto(root, ref, namespace),
  );
  return newest.kind === "release" ? newest.tag : null;
}

/** Every `v*` tag in `namespace` whose commit is in `ref`'s history, by tag name. */
async function releaseTagsMergedInto(
  root: string,
  ref: string,
  namespace: string,
): Promise<string[]> {
  const listed = await spawnExpectOk(
    [
      "git",
      "for-each-ref",
      `--merged=${ref}`,
      "--format=%(refname)",
      `${namespace}${RELEASE_TAG_GLOB}`,
    ],
    { cwd: root, timeoutMs: LOCAL_TIMEOUT_MS },
  );
  return listed.stdout
    .split("\n")
    .filter((l) => l.startsWith(namespace))
    .map((l) => l.slice(namespace.length));
}

/**
 * Is upstream's release `latest` in `commit`'s history? What "installed"
 * means for a backend: the commit it was built from holds the release.
 */
export async function releaseInCommit(
  root: string,
  remote: string,
  latest: string,
  commit: string,
): Promise<boolean> {
  return isAncestor(
    root,
    `${upstreamReleaseNamespace(remote)}${latest}`,
    commit,
  );
}

/** Is `commit` in `ref`'s history? `merge-base --is-ancestor` is exit-code-as-answer. */
async function isAncestor(
  root: string,
  commit: string,
  ref: string,
): Promise<boolean> {
  const argv = ["git", "merge-base", "--is-ancestor", commit, ref];
  const r = await spawnCaptured(argv, {
    cwd: root,
    timeoutMs: LOCAL_TIMEOUT_MS,
  });
  if (r.exitCode === 0) return true;
  if (r.exitCode === 1) return false;
  throw new SpawnFailedError(
    argv,
    r.exitCode,
    r.signalCode,
    r.stdout,
    r.stderr,
  );
}

/**
 * Fetch upstream's main and release tags, and say where local `main` stands
 * against upstream's newest release.
 *
 * ONE definition of that question, because several things ask it: `./equin
 * upstream status|merge`, `./equin version`, main's daily detection job and the
 * Upstream merges automation. They would run the same git commands either way —
 * this is them written once, so the command a user runs by hand and the status
 * the app shows can never disagree about what "behind" means.
 *
 * It fetches. That is the point of calling it: the tags on disk are as old as
 * the last fetch. Upstream's `main` is fetched with them (its remote-tracking
 * ref is what the published-migrations set reads, and what a release tag is
 * checked to sit on). Nothing else is written — no merge, no checkout, no ref
 * of ours moves but the fetched ones.
 *
 * Upstream's releases are the `v*` tags merged into `<remote>/main`: a tag of
 * the user's own, or one upstream has not published on its main, is not a
 * release they can be told about.
 *
 * The fetch is the one call that may fail without it being a bug (see
 * {@link isCouldNotAsk}); every local git call after it throws with git's own
 * words rather than coming back as "no release".
 */
export async function fetchUpstreamStatus(
  root: string,
): Promise<UpstreamStatus> {
  const upstream = await resolveUpstreamRemote(root);
  if (upstream.kind === "none")
    return { kind: "no-upstream", reason: upstream.reason };

  const namespace = upstreamReleaseNamespace(upstream.remote);
  // `--no-tags`: upstream's tags go to their own namespace only, never
  // auto-followed into `refs/tags/`. `+` and `--prune` keep that namespace a
  // mirror of upstream's release tags (re-cut and retracted ones included).
  const argv = [
    "git",
    "fetch",
    "--no-tags",
    "--prune",
    upstream.remote,
    UPSTREAM_BRANCH,
    `+refs/tags/${RELEASE_TAG_GLOB}:${namespace}${RELEASE_TAG_GLOB}`,
  ];
  const fetched = await spawnCaptured(argv, {
    cwd: root,
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (fetched.exitCode !== 0 || fetched.timedOut) {
    const failure = classifyRemoteFailure(fetched);
    if (isCouldNotAsk(failure.kind))
      return {
        kind: "unreachable",
        remote: upstream.remote,
        url: upstream.url,
        detail: failure.detail,
      };
    throw new SpawnFailedError(
      argv,
      fetched.exitCode,
      fetched.signalCode,
      fetched.stdout,
      fetched.stderr,
    );
  }

  const where = { remote: upstream.remote, url: upstream.url };
  const latest = newestReleaseTag(
    await releaseTagsMergedInto(
      root,
      `${upstream.remote}/${UPSTREAM_BRANCH}`,
      namespace,
    ),
  );
  if (latest.kind === "none")
    return {
      kind: "no-release",
      ...where,
      current: await currentRelease(root, UPSTREAM_BRANCH, namespace),
    };
  const standing = await standingAgainst(root, upstream.remote, latest.tag);
  const ref = `${namespace}${latest.tag}`;
  return standing.kind === "current"
    ? { kind: "current", ...where, release: latest.tag, ref }
    : {
        kind: "behind",
        ...where,
        current: standing.current,
        latest: latest.tag,
        ref,
      };
}

/** Where local `main` stands against one release tag already on disk. */
export type ReleaseStanding =
  { kind: "current" } | { kind: "behind"; current: string | null };

/**
 * Is upstream's release `latest` in local `main`? Local only — no fetch — so a
 * reader that already knows upstream's newest release (the stored answer of the
 * last check) re-derives the rest from git whenever `main` moves.
 *
 * The release must be in `remote`'s release namespace — a check fetched it
 * there. Its absence (the namespace pruned by hand, the checkout re-cloned
 * under an old database) is said in those words rather than as git's exit 128.
 */
export async function standingAgainst(
  root: string,
  remote: string,
  latest: string,
): Promise<ReleaseStanding> {
  const namespace = upstreamReleaseNamespace(remote);
  const ref = `${namespace}${latest}`;
  const present = await spawnCaptured(
    ["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { cwd: root, timeoutMs: LOCAL_TIMEOUT_MS },
  );
  if (present.exitCode !== 0)
    throw new Error(
      `Release ${latest} of ${remote} is not on disk (${ref} is missing), so where main stands against it is unknown. ` +
        `Check upstream again (POST /api/upstream/check, or \`./equin upstream status\`) to fetch it.`,
    );
  if (await isAncestor(root, ref, UPSTREAM_BRANCH)) return { kind: "current" };
  return {
    kind: "behind",
    current: await currentRelease(root, UPSTREAM_BRANCH, namespace),
  };
}

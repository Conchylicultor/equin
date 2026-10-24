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

/**
 * The branch an update is read from, on both sides. This repo's trunk is
 * `main` everywhere — the local one every worktree branches off, and the
 * upstream one a clone receives from.
 */
export const UPSTREAM_BRANCH = "main";

/** One fetch of a branch that may be far ahead, over the network. */
const FETCH_TIMEOUT_MS = 300_000;

/** `rev-list` / `log` over refs already on disk. */
const LOCAL_TIMEOUT_MS = 60_000;

/**
 * How many of the newest commits come back with their subjects.
 *
 * The COUNT is exact and read separately, so this bounds only the list a caller
 * prints or files: a clone three years behind names its twenty newest commits
 * and still says it is ten thousand behind, rather than carrying ten thousand
 * subjects into a report payload.
 */
export const UPSTREAM_SUBJECT_LIMIT = 20;

export interface UpstreamCommit {
  /** Full sha. */
  sha: string;
  /** The commit's first line. */
  subject: string;
}

/**
 * Where this checkout stands against upstream, as a state with a reason rather
 * than a count that could be read as zero for either "nothing new" or "we never
 * got to ask".
 *
 * - `no-upstream` — this checkout publishes to its own remote (the author), or
 *   has no remote at all. There is nothing to be behind.
 * - `unreachable` — upstream exists and we could not ask it. Distinct from both
 *   of its neighbours on purpose: folding it into `current` would report "no
 *   updates" on the strength of a question nobody answered, and folding it into
 *   `no-upstream` would deny the remote exists.
 * - `current` — upstream answered and holds nothing local `main` does not.
 * - `behind` — upstream holds `count` commits local `main` does not.
 */
export type UpstreamStatus =
  | { kind: "no-upstream"; reason: "is-publisher" | "no-remote" }
  | { kind: "unreachable"; remote: string; url: string; detail: string }
  | { kind: "current"; remote: string; url: string; ref: string }
  | {
      kind: "behind";
      remote: string;
      url: string;
      /** The remote-tracking ref the count was measured against. */
      ref: string;
      /** Exactly how many commits `main..<ref>` holds. */
      count: number;
      /** The newest of them, newest first, at most {@link UPSTREAM_SUBJECT_LIMIT}. */
      newest: UpstreamCommit[];
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

/** `<sha> <subject>`, with a subject that may itself be empty. */
function parseLogLine(line: string): UpstreamCommit {
  const space = line.indexOf(" ");
  return space === -1
    ? { sha: line, subject: "" }
    : { sha: line.slice(0, space), subject: line.slice(space + 1) };
}

/**
 * Fetch upstream and measure how far behind local `main` is.
 *
 * ONE definition of that question, because two things ask it: `./equin
 * upstream status|merge`, and main's daily detection job. They ran the same
 * three git commands either way — this is them written once, so the command a
 * user runs by hand and the report that wakes them up can never disagree about
 * what "behind" means.
 *
 * It fetches. That is the point of calling it: the remote-tracking ref on disk
 * is as old as the last fetch, and a count against a stale ref is a number that
 * looks current and is not. Nothing else is written — no merge, no checkout, no
 * ref of ours moves.
 *
 * The fetch is the one call that may fail without it being a bug (see
 * {@link isCouldNotAsk}); every local git call after it is `spawnExpectOk`, so
 * a `main` that does not exist or an unreadable object store throws with git's
 * own words rather than coming back as zero commits behind.
 */
export async function fetchUpstreamStatus(
  root: string,
): Promise<UpstreamStatus> {
  const upstream = await resolveUpstreamRemote(root);
  if (upstream.kind === "none")
    return { kind: "no-upstream", reason: upstream.reason };

  const argv = ["git", "fetch", upstream.remote, UPSTREAM_BRANCH];
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

  const ref = `${upstream.remote}/${UPSTREAM_BRANCH}`;
  const range = `${UPSTREAM_BRANCH}..${ref}`;
  const where = { remote: upstream.remote, url: upstream.url, ref };

  const counted = await spawnExpectOk(["git", "rev-list", "--count", range], {
    cwd: root,
    timeoutMs: LOCAL_TIMEOUT_MS,
  });
  const count = Number(counted.stdout.trim());
  if (!Number.isInteger(count) || count < 0)
    throw new Error(
      `git rev-list --count ${range} printed ${JSON.stringify(counted.stdout)}, which is not a commit count.`,
    );
  if (count === 0) return { kind: "current", ...where };

  const log = await spawnExpectOk(
    [
      "git",
      "log",
      `--max-count=${UPSTREAM_SUBJECT_LIMIT}`,
      "--format=%H %s",
      range,
    ],
    { cwd: root, timeoutMs: LOCAL_TIMEOUT_MS },
  );
  const newest = log.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map(parseLogLine);

  return { kind: "behind", ...where, count, newest };
}

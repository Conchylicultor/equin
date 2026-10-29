import type { CommitLookup } from "@plugins/release/plugins/bundles/server";
import type { RunningCommit } from "../../core";

/** The ref "behind" is counted against — the shared `main`, never this checkout's HEAD. */
export const MAIN_REF = "refs/heads/main";

/**
 * The newest succeeded shipping run of a deployment, as far as the running
 * commit is concerned — or `none` when nothing has shipped.
 */
export type LatestShip =
  | { readonly kind: "none" }
  | {
      readonly kind: "shipped";
      readonly runId: string;
      readonly commitSha: string | null;
    };

/** The git reads the running commit is folded from — injected so a test can drive a scratch repo. */
export interface RunningCommitGit {
  subject(sha: string): Promise<CommitLookup>;
  mainSha(): Promise<string>;
  behind(sha: string, ref: string): Promise<number>;
}

/**
 * Fold the newest succeeded ship into the running-commit answer.
 *
 * Every arm that cannot name a commit is `unknown` with its own reason: no
 * stand-in sha, and no zero count that would read as "up to date".
 */
export async function computeRunningCommit(
  latest: LatestShip,
  git: RunningCommitGit,
): Promise<RunningCommit> {
  if (latest.kind === "none") {
    return {
      kind: "unknown",
      reason: "nothing has been shipped to this deployment yet",
    };
  }
  const sha = latest.commitSha;
  if (sha === null) {
    return {
      kind: "unknown",
      reason: `the run that shipped what is live (${latest.runId}) recorded no commit`,
    };
  }
  const lookup = await git.subject(sha);
  if (lookup.kind === "unknown") {
    return { kind: "unknown", reason: lookup.reason };
  }
  // Counted against the sha reported, not the ref: main can move between the
  // two reads, and the count must describe the `mainSha` it is shipped with.
  const mainSha = await git.mainSha();
  const behindMain = await git.behind(sha, mainSha);
  return { kind: "known", sha, subject: lookup.subject, behindMain, mainSha };
}

import { REPO_ROOT } from "@plugins/infra/plugins/paths/server";
import {
  resolved,
  unresolved,
  type Resolvable,
} from "@plugins/primitives/plugins/live-state/core";
import {
  LOG_FORMAT,
  parseGitLog,
  runGit,
  tryRunGit,
  WorktreeGoneError,
} from "@plugins/primitives/plugins/commit-list/server";
import { CHAIN_CAP, sameCommit, type Chain } from "../../core";

/**
 * The three git reads every chain question is built from, in one place: where
 * the target is, whether a commit is on the line leading to it, and the walk
 * between the two.
 *
 * Both consumers ask the same three questions of the same checkout — the
 * deployment resource (the chain from the oldest deployable pin) and the
 * chain-from endpoint (the chain from a pin only a browser knows) — so they
 * share one implementation rather than two that can drift on the edge cases.
 */

/**
 * This checkout's HEAD — the commit everything should converge ON.
 *
 * No namespace branching is needed: main's checkout is on `main` and a worktree
 * checkout is on its own branch, so `HEAD` of `REPO_ROOT` is the target in both.
 * (`computeTrackedRefs` in git-watcher already watches both refs, so the
 * resource's `dependsOn` fires either way.)
 *
 * A checkout that git cannot answer for is `unresolved`, not an error: a release
 * bundle's `REPO_ROOT` resolves into the compiled binary's virtual FS, where
 * there is no repository and the question is genuinely unanswerable.
 */
export async function readTarget(): Promise<Resolvable<string>> {
  const result = await tryRunGit(["rev-parse", "HEAD"], REPO_ROOT).catch(
    (err: unknown) => {
      // The one determinate arm worth folding in here: no directory at all is
      // the same answer as no repository. Anything else is a real fault.
      if (err instanceof WorktreeGoneError) return null;
      throw err;
    },
  );
  if (result === null || !result.ok) return unresolved("no checkout");
  const sha = result.stdout.trim();
  return sha ? resolved(sha) : unresolved("no checkout");
}

/**
 * Is `commit` on the line leading to `target`? Answered by git, once, on the
 * server, and carried onto the carrier as a plain fact so `convergenceOf` /
 * `wantsBuild` stay pure.
 *
 * `merge-base --is-ancestor` is an exit-code-as-signal command — 0 yes, 1 no —
 * which is exactly the case `tryRunGit`'s docstring names. Any OTHER exit code
 * means git could not answer the question at all (typically 128: the commit is
 * not an object in this checkout, e.g. a dist built in a worktree whose branch
 * has since been pruned), and that is a determinate "cannot tell", never a
 * silent `false` that would read as divergence.
 */
export async function isAncestor(
  commit: string,
  target: string,
): Promise<Resolvable<boolean>> {
  // Free answer, and it saves a subprocess on the common converged path.
  if (sameCommit(commit, target)) return resolved(true);
  const result = await tryRunGit(
    ["merge-base", "--is-ancestor", commit, target],
    REPO_ROOT,
  );
  if (result.ok) return resolved(true);
  if (result.exitCode === 1) return resolved(false);
  return unresolved(`git cannot place ${commit.slice(0, 9)} in this checkout`);
}

/**
 * The commit chain the Build button draws: the commits from `base` up to
 * `target`, newest first, INCLUSIVE of `base`'s own commit so a carrier badge
 * has a row to sit on.
 *
 * Two logs rather than one range expression: `<base>..<target>` excludes `base`
 * itself, and the spellings that include it (`<base>^..`, `<base>~1..`) break on
 * a root commit. Two exact reads have no edge case.
 *
 * **Capped at {@link CHAIN_CAP}.** The range is normally one working session's
 * drift, but nothing bounds it — a tab open for a fortnight asks for hundreds of
 * commits, and nobody wants that walked, shipped and rendered to answer "how far
 * behind am I". `-n CAP+1` is what makes the cap detectable: asking for one more
 * than we will keep is how a full walk is told apart from one cut short, without
 * a second count. A capped walk does NOT read `base`'s own row — it never got
 * there — so `truncated` is what the UI says instead of drawing a chain that
 * looks complete.
 *
 * `runGit` (not `tryRunGit`): every caller has already placed both shas in this
 * checkout, so a failure now is a genuine fault and belongs in the caller's
 * error channel — a retry may succeed — rather than being absorbed into an empty
 * chain that would render as "nothing to deploy".
 */
export async function chainTo(base: string, target: string): Promise<Chain> {
  const ahead = parseGitLog(
    await runGit(
      [
        "log",
        `--format=${LOG_FORMAT}`,
        "-n",
        String(CHAIN_CAP + 1),
        `${base}..${target}`,
      ],
      REPO_ROOT,
    ),
  );
  if (ahead.length > CHAIN_CAP)
    return { commits: ahead.slice(0, CHAIN_CAP), truncated: true };
  const baseRow = parseGitLog(
    await runGit(["log", `--format=${LOG_FORMAT}`, "-1", base], REPO_ROOT),
  );
  return { commits: [...ahead, ...baseRow], truncated: false };
}

import {
  runGit,
  tryRunGit,
} from "@plugins/primitives/plugins/commit-list/server";
import type { ConversationPhase } from "../../core";

// - research:       no files modified vs main
// - design:         only research/** files modified
// - implementation: any non-research file modified
export function phaseOfFiles(files: readonly string[]): ConversationPhase {
  if (files.length === 0) return "research";
  if (files.some((f) => !isResearchPath(f))) return "implementation";
  return "design";
}

export function isResearchPath(relPath: string): boolean {
  return relPath.startsWith("research/");
}

/**
 * The branch's base: where it left `main`. Null when there is none — no `main`
 * in this repo, or a workspace that is no git checkout at all (a scratch
 * directory): either way nothing can be "changed against main", so research.
 */
export async function mergeBase(worktreePath: string): Promise<string | null> {
  const result = await tryRunGit(["merge-base", "main", "HEAD"], worktreePath);
  if (!result.ok) return null;
  const base = result.stdout.trim();
  return base === "" ? null : base;
}

/**
 * The phase of the WHOLE worktree: every changed file against `base`
 * (committed, staged, unstaged) plus every untracked one. This lstats every
 * tracked file and readdirs the whole tree, cold whenever the vnode cache has
 * moved on — so it is the baseline a watch starts from and the answer to a
 * lost watch, never a per-turn read.
 */
export async function wholeTreePhase(
  worktreePath: string,
): Promise<ConversationPhase> {
  const base = await mergeBase(worktreePath);
  if (base === null) return "research";
  const changed = await runGit(
    ["diff", "--name-only", "-z", base],
    worktreePath,
  );
  const untracked = await runGit(
    ["ls-files", "-z", "--others", "--exclude-standard"],
    worktreePath,
  );
  return phaseOfFiles(splitZ(changed + untracked));
}

/**
 * Pathspecs per git call: well under the argv limit for any repo path, and a
 * rebase's thousands of paths still cost a handful of spawns.
 */
const PATHS_PER_CALL = 500;

/**
 * Which of `relPaths` (worktree-relative) differ from `base` — tracked and
 * changed against it, or untracked and not ignored. Each git call is limited
 * to those paths, so it stats them (and readdirs only their ancestors), never
 * the rest of the tree: the cost is the size of the change, not of the
 * checkout. Paths are literal (`--literal-pathspecs`): a file named `*.ts`
 * is that file, not a glob over the tree.
 */
export async function changedAmong(
  worktreePath: string,
  base: string,
  relPaths: readonly string[],
): Promise<string[]> {
  const changed: string[] = [];
  for (let i = 0; i < relPaths.length; i += PATHS_PER_CALL) {
    const chunk = relPaths.slice(i, i + PATHS_PER_CALL);
    const diff = await runGit(
      [
        "--literal-pathspecs",
        "diff",
        "--name-only",
        "-z",
        base,
        "--",
        ...chunk,
      ],
      worktreePath,
    );
    const untracked = await runGit(
      [
        "--literal-pathspecs",
        "ls-files",
        "-z",
        "--others",
        "--exclude-standard",
        "--",
        ...chunk,
      ],
      worktreePath,
    );
    changed.push(...splitZ(diff + untracked));
  }
  return changed;
}

function splitZ(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

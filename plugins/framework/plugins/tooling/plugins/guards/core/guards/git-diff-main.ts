import { execFileSync } from "node:child_process";
import { rewriteCalls } from "../call-splice";
import { defineGuard } from "../define-guard";
import type { ShellCall } from "../parse-shell";
import type { BashInput } from "../types";

const MAIN_REFS = new Set(["main", "origin/main"]);

/** `git diff` options whose value is the next token, so it is no revision. */
const VALUE_OPTIONS = new Set(["-S", "-G", "-O"]);

/**
 * The revisions a `git diff` names: its non-option words before `--`, or all
 * of them when there is no `--` (where a path would count too — a call that
 * then names more than one word is simply not judged).
 */
function revisions(args: string[]): { word: string; index: number }[] {
  const revs: { word: string; index: number }[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") break;
    if (VALUE_OPTIONS.has(a)) {
      i++;
      continue;
    }
    if (!a.startsWith("-")) revs.push({ word: a, index: i });
  }
  return revs;
}

/**
 * `git diff main` / `git diff origin/main` — the working tree against main's
 * CURRENT tip, which shows every commit merged to main since the branch point
 * as a reversed change of this branch's.
 *
 * Only the one-revision form. Two revisions (`git diff X origin/main`,
 * `git diff HEAD origin/main`) is a deliberate comparison — what main gained
 * since a commit, what a rebase will bring in — and a three-dot range already
 * diffs from the merge-base. Replayed over 68 Opus denials, those forms were
 * most of them, and every one was re-run unchanged.
 */
function diffsTreeAgainstMain(c: ShellCall): boolean {
  if (c.name !== "git" || c.args[0] !== "diff") return false;
  if (c.args.includes("--no-index")) return false;
  const revs = revisions(c.args);
  return revs.length === 1 && MAIN_REFS.has(revs[0]!.word);
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
  } catch (err) {
    // A failed git is an answer here ("no merge-base to rewrite to"), not a
    // fault: the guard then leaves the command as typed.
    if (err instanceof Error) return null;
    throw err;
  }
}

/**
 * Rewrites the one-revision form to the merge-base, resolved HERE to a sha
 * rather than spliced in as `$(git merge-base …)`: a substitution that fails
 * expands to nothing, and `git diff -- <paths>` would then silently diff
 * against the index instead.
 *
 * Nothing is rewritten when the branch already contains main's tip (the
 * merge-base IS main), since the two spellings then show the same diff.
 */
export const gitDiffMainGuard = defineGuard<BashInput>({
  name: "git-diff-main",
  matcher: "Bash",
  check(input, ctx) {
    const cmd = input.command;
    if (!cmd || !cmd.includes("main")) return null;
    const replaced: string[] = [];
    let unresolved = false;
    const rewritten = rewriteCalls(
      cmd,
      ctx.cwd,
      (c) => diffsTreeAgainstMain(c) && !replaced.includes(c.raw),
      (call, words) => {
        const rev = revisions(call.args)[0]!;
        const cwd = call.cwd || ctx.cwd;
        const base = git(cwd, ["merge-base", "HEAD", rev.word]);
        const tip = git(cwd, ["rev-parse", "--verify", `${rev.word}^{commit}`]);
        if (base === null || tip === null) {
          unresolved = true;
          return null;
        }
        // Same diff either way: leave the words, stop selecting the call.
        if (base === tip) {
          replaced.push(call.raw);
          return [];
        }
        const word = words.args[rev.index]!;
        return [{ from: word.start, to: word.end, text: base }];
      },
    );
    if (rewritten === null || rewritten === cmd) {
      if (!unresolved) return null;
      return {
        inform:
          "`git diff main` compares against main's CURRENT tip, which includes commits merged after your branch point (they show as reversed changes). Your worktree's own changes are `git diff $(git merge-base HEAD main)`.",
      };
    }
    return {
      rewrite: { command: rewritten },
      note: `Your \`git diff main\` was rewritten to diff against the merge-base of HEAD and main, and ran as:\n  ${rewritten}\nmain's current tip includes commits merged after your branch point, which would show as reversed changes of yours. Write \`git diff $(git merge-base HEAD main)\` yourself next time. To compare against main's current tip on purpose, name it \`refs/heads/main\` (or \`refs/remotes/origin/main\`), which is left as typed.`,
    };
  },
});

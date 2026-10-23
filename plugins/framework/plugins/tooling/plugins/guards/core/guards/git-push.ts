import { defineGuard } from "../define-guard";
import { classifyRepo, readGitInvocation } from "../git-target";
import { findCall } from "../parse-shell";
import type { BashInput } from "../types";

export const gitPushGuard = defineGuard<BashInput>({
  name: "git-push",
  matcher: "Bash",
  // Escape hatch for when the CLI push flow itself is unavailable (e.g. the
  // 2026-07-21 op-wedge holding the push mutex): user-approved raw branch push.
  // Same contract as .allow-main / .allow-postgres — an agent may create the
  // token ONLY when the user explicitly says so, in the current conversation.
  bypassToken: ".allow-git-push",
  check(input, ctx) {
    const cmd = input.command;
    if (!cmd) return null;

    // Only a push INTO a Singularity checkout is refused: that repo lands work
    // through `./equin push`. A push to a separate repo (a package an
    // agent publishes on its own) has no CLI flow to bypass. Anything this
    // cannot place — an unfollowed --git-dir, a directory that is no repo —
    // is treated as Singularity.
    const gitPush = findCall(
      cmd,
      (c) => {
        if (c.name !== "git") return false;
        const git = readGitInvocation(c);
        if (git.subcommand !== "push") return false;
        return (
          git.repo.kind === "unknown" ||
          classifyRepo(git.repo.path).kind !== "other"
        );
      },
      ctx.cwd,
    );
    if (!gitPush) return null;

    return {
      blocked:
        "`git push` into the Singularity repo is not allowed — agents must use the Singularity CLI.",
      why: "Raw git push bypasses validation checks, worktree-merge flow, and branch protection. A previous agent ran `git push origin main` directly and corrupted shared state.",
      hint: 'Use `./equin push -m "commit message"` instead. It runs checks, commits, and pushes via the proper worktree-merge flow. (Pushes into a separate, non-Singularity repo are allowed — run them from that repo\'s directory, or with `git -C <dir> push`.)',
    };
  },
});

/**
 * Tests for `no-raw-worktree-git`: the worktree-enumerating git commands are
 * reported as argv lists (array literals, `git(…)` helper arguments, the `GIT`
 * constant, a spread git-argv helper) and as shell strings; other git commands, a safe switch and prose
 * stay valid. The worktree plugin itself is exempted by its own
 * exempt/index.ts, so here the rule fires everywhere.
 */

import rule from "./no-raw-worktree-git";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();
const err = [{ messageId: "rawWorktreeGit" as const }];

ruleTester.run("no-raw-worktree-git", rule, {
  valid: [
    { code: `spawn(["git", "rev-parse", "--git-common-dir"]);` },
    { code: `spawn([GIT, "-C", dir, "worktree", "prune"]);` },
    { code: `git(["switch", "--ignore-other-worktrees", branch]);` },
    { code: `git(repo, "switch", "--detach", "HEAD");` },
    { code: `git(repo, "switch", "-c", branch, "main");` },
    { code: `const cmd = "git switch -c topic";` },
    {
      code: `spawn([...checkoutGit(wt), "switch", "--ignore-other-worktrees", b]);`,
    },
    // A `switch` that is not a git argv.
    { code: `render({ select: "switch" });` },
    { code: `const roles = ["button", "switch"];` },
    // Prose mentioning the command mid-sentence.
    { code: `const msg = "never run git worktree list here";` },
  ],
  invalid: [
    { code: `spawn(["git", "worktree", "list", "--porcelain"]);`, errors: err },
    {
      code: `spawnCaptured([GIT, "-C", repo, "worktree", "add", p]);`,
      errors: err,
    },
    { code: `git(["worktree", "lock", wt]);`, errors: err },
    { code: `git(repo, "worktree", "move", a, b);`, errors: err },
    { code: `run(["git", "switch", branch]);`, errors: err },
    { code: `spawn([...checkoutGit(wt), "switch", branch]);`, errors: err },
    { code: `git(wt, "switch", "-C", branch);`, errors: err },
    { code: `const cmd = "git worktree list --porcelain";`, errors: err },
    { code: `exec("cd x && git -C repo worktree unlock wt");`, errors: err },
    { code: "const c = `git switch $" + "{branch}`;", errors: err },
    {
      code: "const c = `$" + "{GIT} worktree remove $" + "{wt}`;",
      errors: err,
    },
  ],
});

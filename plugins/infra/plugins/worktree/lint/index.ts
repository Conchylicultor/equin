import noRawWorktreeGit from "./no-raw-worktree-git";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "worktree",
  rules: {
    "no-raw-worktree-git": noRawWorktreeGit,
  },
} satisfies LintContribution;

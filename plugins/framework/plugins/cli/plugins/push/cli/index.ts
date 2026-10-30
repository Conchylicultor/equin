import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * The only sanctioned way work reaches `main`. Everything the verb implies —
 * the commit, the rebase, the generated-artifact re-derivation, the tree-scoped
 * check pass, the fast-forward merge — happens inside `run.ts`, serialized
 * host-wide by the `push` pool so two agents can never race on main.
 *
 * The declaration itself is data, so `./equin --help` and every other
 * invocation pay for this file alone; the body (and the host-admission, worktree
 * and profiler barrels it reaches) loads only when a push actually runs.
 */
export default defineCliCommand<
  [],
  { message?: string; fromMain?: boolean; unattributed?: string }
>({
  name: "push",
  description: "Commit (if -m provided), merge into main, and push",
  options: [
    {
      flags: "-m, --message <msg>",
      description:
        "Commit message — stages and commits all changes before pushing",
    },
    {
      flags: "--from-main",
      description:
        "DANGER: commit and push directly from main, bypassing the worktree-merge flow. " +
        "Agents MUST NOT pass this flag without explicit user approval in the current conversation. " +
        "Intended only when a human is driving and the worktree detour would be pure churn " +
        "(e.g. small fixes already staged on main). Still runs checks.",
    },
    {
      flags: "--unattributed <reason>",
      description:
        "Land a push that credits no conversation and no attempt, stamping the one-line <reason> instead. " +
        "Only for a session equin did not launch (no conversation id in its environment) on a branch that is no attempt's — " +
        "refused whenever the push is attributable (an attempt's claude-web/<id> branch is credited automatically). " +
        "Agents MUST NOT pass this flag without explicit user approval in the current conversation.",
    },
  ],
  run: () => import("./run"),
});

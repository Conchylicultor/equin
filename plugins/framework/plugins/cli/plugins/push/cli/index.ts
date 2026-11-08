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
  {
    message?: string;
    fromMain?: boolean;
    unattributed?: string;
    fixesReport?: string[];
    reportFixedBy?: string[];
  }
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
      flags: "--fixes-report <id...>",
      description:
        "The report(s) this push fixes (report-…, one of main's — Debug → Reports). Stamps a Fixes-report trailer; " +
        "main records the fix when the push lands, marks it Fixed once main runs it, and Regressed if it fires again from code that has it. " +
        "The only way to name a fix: a Fixes-report: line in -m is refused.",
    },
    {
      flags: "--report-fixed-by <id@sha...>",
      description:
        "Claim that an EARLIER commit on main fixed a report it did not name (<report-id>@<sha>, the sha on main). Stamps a Report-fixed-by trailer; " +
        "the ledger judges that commit exactly like a --fixes-report one: Fixed once main runs it, Regressed if the report fired — or fires — from code that has it.",
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

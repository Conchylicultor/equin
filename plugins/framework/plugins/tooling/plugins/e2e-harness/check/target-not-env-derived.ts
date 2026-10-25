import { grepCode } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";

/**
 * An e2e script never learns which deploy it drives from the environment.
 *
 * The defect this closes was the retired worktree variable, which answered a question
 * about a different process: the gateway set it on every backend it spawned, so
 * it meant "which namespace is this BACKEND the server for". An agent's pane was
 * spawned by main's backend and inherited the variable through the tmux server's
 * environment, so inside a worktree checkout it was always present and always
 * named the main namespace. A script that read it therefore drove MAIN's app from a
 * worktree and printed `ALL CHECKS PASSED` — it did exercise an app, just not
 * the one under test, and the transcript recorded a green run against code the
 * change was not in. That variable is gone now
 * (`research/2026-09-15-global-retire-ambient-worktree-env-runtime-identity.md`),
 * but the SHAPE it had is what this check is about, and the shape is not.
 *
 * The reads are not passive either. `withBrowser` opens by restoring the config
 * documents a previous run left changed, at the resolved origin; and the one
 * script that carried this expression, `mailbox-tabs-verify.ts`, `rmSync`s a
 * config file at the namespace it computed. Resolved to main, both of those
 * land on the user's live documents.
 *
 * The pattern is the helper family, deliberately, not one variable name.
 * The retired e2e-base variable had the same shape — an inherited channel that
 * silently outranks the derivation — and was deleted for the same reason, so a
 * SECOND env-shaped target must be unspellable rather than merely absent today.
 * A rule keyed on one variable name would watch the one spelling we already know
 * about.
 *
 * Scoped to `e2e/`, which is where the target comes from the deploy registry on
 * disk instead (`target.ts` → `resolveCheckoutDeploy`). The harness's own
 * `target.ts` is excluded by path: it is the file that resolves the target at
 * all, so the check is about the scripts rather than about the resolver. It
 * reads no environment variable today either — the exclusion names that single
 * file, not the harness directory, so a second file in the harness reaching for
 * one is caught like any other.
 */

/**
 * Any READ of the app's own environment variables (`readEnv`, the one reader;
 * a hand-spelled `process.env.EQUIN_…` fails `launcher:env-names`) — the
 * family, not one variable. Setting one for a child the script spawns
 * (`envEntries`) chooses nothing about this run's target, so it is allowed.
 */
const OFFENDING = /\breadEnv\s*\(/;

/** Same shape in POSIX ERE, for the `git grep -l` candidate pre-filter. */
const GREP_ARG = "readEnv[[:space:]]*\\(";

/**
 * Only `e2e/` files, and never the harness's own target resolver.
 *
 * A pathspec exclusion rather than an allowlist entry, for the same reason as
 * the sibling check: the one file that may legitimately be *about* target
 * resolution is identified by WHERE it is, and a second harness file reading the
 * environment would be exactly as wrong as a script doing it.
 */
const PATHSPECS = [
  "*/e2e/*.ts",
  ":(exclude)plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/target.ts",
];

const check: Check = {
  id: "e2e-harness:target-not-env-derived",
  description:
    "e2e scripts derive their target from the deploy this checkout published, never from one of the app's own environment variables (`readEnv`) — one inherited from main's backend names main from every worktree",
  async run(): Promise<CheckResult> {
    const root = await getWorktreeRoot();
    // Comments are masked unconditionally, so a docblock naming the variable —
    // including the corrected ones that explain why it must not be read — does
    // not trip the check. Strings are deliberately left readable: a script that
    // hands the read to another process as a command string has done the same
    // thing at one remove.
    const matches = await grepCode({
      root,
      pattern: OFFENDING,
      grepArg: GREP_ARG,
      maskStrings: false,
      pathspecs: PATHSPECS,
    });

    if (matches.length === 0) return { ok: true };

    const listed = matches
      .map((m) => `${m.path}:${m.line}  ${m.text.trim()}`)
      .join("\n    ");
    return {
      ok: false,
      message: `${matches.length} environment-derived target read(s) in e2e scripts:\n    ${listed}`,
      hint:
        "An e2e script's process inherits its environment from whatever spawned its agent " +
        "session, so an environment-derived target is a claim nobody in this run made — and " +
        "the last one silently drove and wrote to MAIN's deploy. Use `pathUrl(path)` for a " +
        "URL, `targetNamespace()` " +
        "for the namespace whose files you assert on, `--composition <id>` for a composition, " +
        "`--url` for a deploy this checkout did not build.",
    };
  },
};

export default check;

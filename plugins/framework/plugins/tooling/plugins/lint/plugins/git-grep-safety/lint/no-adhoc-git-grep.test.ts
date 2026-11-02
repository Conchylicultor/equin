/**
 * Tests for the `no-adhoc-git-grep` lint rule. Run with `bun test`.
 *
 * The rule bans hand-rolling a bare `git grep`, which is blind to untracked
 * files and the check-runner scan tree. It fires on (A) a `spawn` / `spawnSync`
 * whose argv array literal begins `["git", "grep", …]`, and (B) a string /
 * template used as a `git grep …` shell command. Unrelated git spawns
 * (`git add`, `git rev-parse`) and prose that merely mentions the token
 * mid-sentence stay valid.
 *
 * Invalid `code` embeds `git grep` inside a JS string (preceded by a `"` quote,
 * never a shell separator), so the command-position anchor means this test file
 * itself is not self-flagged — no allowlist entry for it is needed.
 */

import rule from "./no-adhoc-git-grep";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-adhoc-git-grep", rule, {
  valid: [
    // Other git subcommands are not `git grep` — argv starts ["git", "add"].
    { code: `Bun.spawn(["git", "add", "-A"]);` },
    { code: `Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]);` },
    { code: `spawn(["git", "write-tree"]);` },
    // Prose that merely mentions the token mid-sentence (not a command).
    { code: `const doc = "prefer grepCode over a raw git grep call";` },
    // An unrelated string with no `git grep` at all.
    { code: `const msg = "use listCandidateSources instead";` },
  ],
  invalid: [
    // Case A: a spawn argv beginning ["git", "grep", …].
    {
      code: `Bun.spawn(["git", "grep", "-l", "-e", "Pane.define"]);`,
      errors: [{ messageId: "adhocGitGrep" }],
    },
    {
      code: `spawnSync(["git", "grep", "-lF", "defineRoute"]);`,
      errors: [{ messageId: "adhocGitGrep" }],
    },
    // Case B: a string literal used as a `git grep …` shell command.
    {
      code: `const cmd = "git grep -l -e Pane.define"; run(cmd);`,
      errors: [{ messageId: "adhocGitGrep" }],
    },
    // Case B (template form): a `git grep …` command in a template literal.
    // `code` is a plain string (no interpolation) so it can embed backticks.
    {
      code: "const cmd = `git grep -l defineRoute`;",
      errors: [{ messageId: "adhocGitGrep" }],
    },
  ],
});
